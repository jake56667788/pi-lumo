import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { addDiscoveryNote } from "./discovery-notes.ts";
import { isLumoCookieDomain, isUsableLumoToken } from "./lumo-domain.ts";
import { querySqliteRows } from "./sqlite-cookies.ts";

/**
 * Shared cookie-discovery engine for Chromium-family browsers (Chrome, Chromium, Brave, and
 * any other browser using the same on-disk Cookies database and OSCrypt encryption scheme).
 * Each browser supplies its own {@link ChromiumBrowserConfig}.
 */

export interface ChromiumCredentials {
  uid: string;
  token: string;
  profile: string;
}

export interface ChromiumBrowserConfig {
  /** Human-readable browser name used in messages, e.g. "Brave". */
  displayName: string;
  /** macOS Keychain generic-password service name, e.g. "Chrome Safe Storage". */
  keychainServiceName: string;
  /** Linux libsecret "application" attribute, e.g. "chrome". */
  secretToolApplication: string;
  /** Path segments under `~/Library/Application Support`, e.g. ["Google", "Chrome"]. */
  macAppSupportPath: string[];
  /** Path segments under `$XDG_CONFIG_HOME`, e.g. ["google-chrome"]. */
  linuxConfigPath: string[];
  /** Flatpak application id, e.g. "com.google.Chrome". */
  flatpakAppId: string;
  /** Profile roots under `~/snap`, when an official snap exists, e.g. [["chromium", "common", "chromium"]]. */
  snapPaths?: string[][];
  /** Path segments of the "User Data" directory under `%LOCALAPPDATA%` on Windows. */
  windowsUserDataPath?: string[];
  /** Environment variable name for a manual profile override, e.g. "LUMO_CHROME_PROFILE". */
  profileEnvVar: string;
  /** Namespaces locked-database temp snapshots, e.g. "pi-lumo-chrome-". */
  snapshotPrefix: string;
}

interface ChromiumCookieRow {
  host_key: string;
  name: string;
  value_hex: string;
  encrypted_hex: string;
}

const SAFE_STORAGE_SALT = "saltysalt";
const SAFE_STORAGE_IV = Buffer.alloc(16, 0x20);
const SAFE_STORAGE_KEY_LENGTH = 16;
/** Chromium's PBKDF2 iteration counts differ by OS keychain implementation. */
const SAFE_STORAGE_ITERATIONS: Record<string, number> = { darwin: 1003, linux: 1 };
/** Password Chromium uses on Linux for `v10` values when no keyring is in use. */
const LINUX_DEFAULT_PASSWORD = "peanuts";
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const MANUAL_SETUP = "set LUMO_UID and LUMO_TOKEN by hand instead (see the pi-lumo README).";

export function profileRootsForBrowser(
  config: ChromiumBrowserConfig,
  home = homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
  currentPlatform: NodeJS.Platform = platform(),
  localAppData = process.env.LOCALAPPDATA,
): string[] {
  let roots: string[];
  if (currentPlatform === "win32") {
    roots =
      config.windowsUserDataPath && localAppData ? [join(localAppData, ...config.windowsUserDataPath)] : [];
  } else if (currentPlatform === "darwin") {
    roots = [join(home, "Library", "Application Support", ...config.macAppSupportPath)];
  } else {
    roots = [
      join(xdgConfigHome || join(home, ".config"), ...config.linuxConfigPath),
      join(home, ".var", "app", config.flatpakAppId, "config", ...config.linuxConfigPath),
      ...(config.snapPaths ?? []).map((segments) => join(home, "snap", ...segments)),
    ];
  }

  return [process.env[config.profileEnvVar], ...roots].filter((path): path is string => Boolean(path));
}

function cookieFilesIn(profileDirectory: string): string[] {
  const files: string[] = [];
  const legacy = join(profileDirectory, "Cookies");
  if (existsSync(legacy)) files.push(legacy);
  const networked = join(profileDirectory, "Network", "Cookies");
  if (existsSync(networked)) files.push(networked);
  return files;
}

export function cookieDatabasesForBrowser(roots: string[]): string[] {
  const databases = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) continue;

    for (const file of cookieFilesIn(root)) databases.add(file);

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const file of cookieFilesIn(join(root, entry.name))) databases.add(file);
    }
  }

  return [...databases];
}

/** Reads the browser's "Safe Storage" password from the OS keychain, prompting the user if needed. */
export function safeStoragePasswordForBrowser(
  config: ChromiumBrowserConfig,
  currentPlatform: NodeJS.Platform = platform(),
): string | undefined {
  try {
    if (currentPlatform === "darwin") {
      return (
        execFileSync("security", ["find-generic-password", "-w", "-s", config.keychainServiceName], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        }).trim() || undefined
      );
    }

    return (
      execFileSync("secret-tool", ["lookup", "application", config.secretToolApplication], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim() || undefined
    );
  } catch {
    // No keychain/keyring entry available.
    return undefined;
  }
}

export function deriveChromiumKey(password: string, currentPlatform: NodeJS.Platform = platform()): Buffer {
  const iterations = SAFE_STORAGE_ITERATIONS[currentPlatform] ?? 1;
  return pbkdf2Sync(password, SAFE_STORAGE_SALT, iterations, SAFE_STORAGE_KEY_LENGTH, "sha1");
}

/**
 * Since cookie database version 24 (Chromium 130), Chromium prepends SHA-256(host_key)
 * to the plaintext before encrypting it. Strip it when it is there.
 */
export function stripHostDigest(plaintext: Buffer, host?: string): Buffer {
  if (!host || plaintext.length < 32) return plaintext;
  const digest = createHash("sha256").update(host, "utf8").digest();
  return plaintext.subarray(0, 32).equals(digest) ? plaintext.subarray(32) : plaintext;
}

/** Decrypts a macOS/Linux `v10`/`v11` value (AES-128-CBC with a PBKDF2-derived key). */
export function decryptChromiumValue(blob: Buffer, key: Buffer, host?: string): string | undefined {
  const prefix = blob.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return undefined;

  try {
    const decipher = createDecipheriv("aes-128-cbc", key, SAFE_STORAGE_IV);
    const decrypted = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    return stripHostDigest(decrypted, host).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Decrypts a Windows `v10` value (AES-256-GCM with the DPAPI-protected key from `Local State`). */
export function decryptWindowsChromiumValue(blob: Buffer, key: Buffer, host?: string): string | undefined {
  if (blob.subarray(0, 3).toString("ascii") !== "v10") return undefined;
  if (blob.length < 3 + GCM_NONCE_LENGTH + GCM_TAG_LENGTH) return undefined;

  try {
    const nonce = blob.subarray(3, 3 + GCM_NONCE_LENGTH);
    const tag = blob.subarray(blob.length - GCM_TAG_LENGTH);
    const ciphertext = blob.subarray(3 + GCM_NONCE_LENGTH, blob.length - GCM_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripHostDigest(decrypted, host).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * `v20` values use Chromium's app-bound encryption (Windows, Chrome 127+ and Brave):
 * their key can only be unwrapped by the browser's own SYSTEM elevation service.
 */
export function isAppBoundEncrypted(blob: Buffer): boolean {
  return blob.subarray(0, 3).toString("ascii") === "v20";
}

/** Finds the `Local State` file in the "User Data" directory a cookie database belongs to. */
export function localStateForDatabase(databasePath: string): string | undefined {
  let directory = dirname(databasePath);
  for (let depth = 0; depth < 3; depth += 1) {
    const candidate = join(directory, "Local State");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

interface LocalStateCrypt {
  encryptedKey?: Buffer;
  appBound: boolean;
}

export function parseLocalState(json: string): LocalStateCrypt {
  try {
    const osCrypt = (JSON.parse(json.replace(/^\uFEFF/, "")) as { os_crypt?: Record<string, unknown> }).os_crypt;
    const encoded = typeof osCrypt?.encrypted_key === "string" ? osCrypt.encrypted_key : undefined;
    const raw = encoded ? Buffer.from(encoded, "base64") : undefined;
    return {
      encryptedKey: raw && raw.subarray(0, 5).toString("ascii") === "DPAPI" ? raw.subarray(5) : undefined,
      appBound: typeof osCrypt?.app_bound_encrypted_key === "string",
    };
  } catch {
    return { appBound: false };
  }
}

/** Unwraps data protected with Windows DPAPI for the current user, via Windows PowerShell. */
export function unprotectWithDpapi(data: Buffer): Buffer {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
    "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null," +
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Console]::Out.Write([Convert]::ToBase64String($out))";
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: data.toString("base64"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 15_000,
    windowsHide: true,
  });
  return Buffer.from(output.trim(), "base64");
}

export function credentialsFromCookieValues(
  values: Array<{ host: string; name: string; value: string }>,
  profile: string,
): ChromiumCredentials | undefined {
  for (const { host, name, value } of values) {
    if (!isLumoCookieDomain(host)) continue;
    if (!name.startsWith("AUTH-") || !isUsableLumoToken(value)) continue;
    const uid = name.slice("AUTH-".length);
    if (uid) return { uid, token: value, profile };
  }
  return undefined;
}

const COOKIE_QUERY = `SELECT host_key, name, hex(value) AS value_hex, hex(encrypted_value) AS encrypted_hex
                         FROM cookies
                        WHERE name LIKE 'AUTH-%'
                        ORDER BY expires_utc DESC`;

export interface ChromiumDiscoveryOptions {
  platform?: NodeJS.Platform;
  /** Windows DPAPI unwrap; replaceable in tests. */
  unprotect?: (data: Buffer) => Buffer;
  /** Keychain/keyring password lookup; replaceable in tests. */
  safeStoragePassword?: () => string | undefined;
  /** Receives a user-facing explanation when a profile exists but its session can't be read. */
  note?: (message: string) => void;
}

/** Decrypts cookie blobs for one platform, fetching keys only when an encrypted row needs one. */
class CookieDecoder {
  private posixKeys?: { v10: Buffer[]; v11: Buffer[] };
  private readonly windowsKeys = new Map<string, Buffer | undefined>();

  constructor(
    private readonly config: ChromiumBrowserConfig,
    private readonly currentPlatform: NodeJS.Platform,
    private readonly options: ChromiumDiscoveryOptions,
  ) {}

  decode(row: ChromiumCookieRow, databasePath: string): { value?: string; appBound?: boolean } {
    if (row.value_hex) return { value: Buffer.from(row.value_hex, "hex").toString("utf8") };
    if (!row.encrypted_hex) return {};
    const blob = Buffer.from(row.encrypted_hex, "hex");

    if (this.currentPlatform === "win32") {
      if (isAppBoundEncrypted(blob)) return { appBound: true };
      const key = this.windowsKey(databasePath);
      return { value: key ? decryptWindowsChromiumValue(blob, key, row.host_key) : undefined };
    }

    const keys = this.posix();
    const candidates = blob.subarray(0, 3).toString("ascii") === "v11" ? keys.v11 : keys.v10;
    for (const key of candidates) {
      const value = decryptChromiumValue(blob, key, row.host_key);
      if (value !== undefined) return { value };
    }
    return {};
  }

  private posix(): { v10: Buffer[]; v11: Buffer[] } {
    if (this.posixKeys) return this.posixKeys;
    const password = (this.options.safeStoragePassword ?? (() => safeStoragePasswordForBrowser(this.config, this.currentPlatform)))();
    const derive = (secret: string) => deriveChromiumKey(secret, this.currentPlatform);

    if (this.currentPlatform === "darwin") {
      const keys = password ? [derive(password)] : [];
      this.posixKeys = { v10: keys, v11: keys };
    } else {
      // Linux: v10 uses the built-in "peanuts" password, v11 the keyring secret.
      this.posixKeys = {
        v10: [derive(LINUX_DEFAULT_PASSWORD)],
        v11: [...(password ? [derive(password)] : []), derive("")],
      };
    }
    return this.posixKeys;
  }

  private windowsKey(databasePath: string): Buffer | undefined {
    const localState = localStateForDatabase(databasePath);
    if (!localState) return undefined;
    if (this.windowsKeys.has(localState)) return this.windowsKeys.get(localState);

    let key: Buffer | undefined;
    try {
      const { encryptedKey } = parseLocalState(readFileSync(localState, "utf8"));
      if (encryptedKey) key = (this.options.unprotect ?? unprotectWithDpapi)(encryptedKey);
    } catch {
      key = undefined;
    }
    this.windowsKeys.set(localState, key);
    return key;
  }
}

function appBoundNote(config: ChromiumBrowserConfig): string {
  return (
    `pi-lumo found your ${config.displayName} profile but can't read its Lumo session: on Windows, ` +
    `${config.displayName} protects cookies with app-bound encryption that only ${config.displayName} itself can unlock. ` +
    `Please ${MANUAL_SETUP}`
  );
}

function localStateIsAppBound(databasePath: string): boolean {
  const localState = localStateForDatabase(databasePath);
  if (!localState) return false;
  try {
    return parseLocalState(readFileSync(localState, "utf8")).appBound;
  } catch {
    return false;
  }
}

export function discoverCredentialsForBrowser(
  config: ChromiumBrowserConfig,
  databases = cookieDatabasesForBrowser(profileRootsForBrowser(config)),
  options: ChromiumDiscoveryOptions = {},
): ChromiumCredentials | undefined {
  const currentPlatform = options.platform ?? platform();
  const note = options.note ?? addDiscoveryNote;
  const decoder = new CookieDecoder(config, currentPlatform, options);

  for (const databasePath of databases) {
    let rows: ChromiumCookieRow[];
    try {
      rows = querySqliteRows<ChromiumCookieRow>(databasePath, COOKIE_QUERY, config.snapshotPrefix);
    } catch (error) {
      if (currentPlatform === "win32" && localStateIsAppBound(databasePath)) {
        // Installing sqlite3 or closing the browser wouldn't help: say what will.
        note(appBoundNote(config));
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        note(
          `pi-lumo needs the sqlite3 command to read ${config.displayName}'s cookies, and it isn't installed` +
            (currentPlatform === "win32" ? " (winget install SQLite.SQLite). " : ". ") +
            `Install it, or ${MANUAL_SETUP}`,
        );
      } else if (currentPlatform === "win32") {
        note(
          `pi-lumo couldn't open ${config.displayName}'s cookie file. On Windows ${config.displayName} locks it while it's running: ` +
            `close ${config.displayName} completely and start Pi again. Or ${MANUAL_SETUP}`,
        );
      }
      continue;
    }

    try {
      let appBound = false;
      const values: Array<{ host: string; name: string; value: string }> = [];
      for (const row of rows) {
        if (!isLumoCookieDomain(row.host_key)) continue;
        const decoded = decoder.decode(row, databasePath);
        if (decoded.appBound) appBound = true;
        if (decoded.value) values.push({ host: row.host_key, name: row.name, value: decoded.value });
      }
      const credentials = credentialsFromCookieValues(values, databasePath);
      if (credentials) return credentials;
      if (appBound) note(appBoundNote(config));
    } catch {
      // A stale or incompatible profile should not prevent Pi startup.
    }
  }

  return undefined;
}
