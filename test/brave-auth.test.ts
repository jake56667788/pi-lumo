import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BRAVE_CONFIG, braveProfileRoots, discoverBraveCredentials } from "../brave-auth.js";
import {
  cookieDatabasesForBrowser,
  decryptWindowsChromiumValue,
  deriveChromiumKey,
  isAppBoundEncrypted,
  parseLocalState,
  profileRootsForBrowser,
  stripHostDigest,
} from "../chromium-cookies.js";

const HOST = ".lumo.proton.me";
const digest = (host: string) => createHash("sha256").update(host, "utf8").digest();

function withEnv<T>(name: string, value: string | undefined, run: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/** Windows: AES-256-GCM, `v10` + 12-byte nonce + ciphertext + 16-byte tag; plaintext prefixed with SHA-256(host). */
function windowsBlob(value: string, key: Buffer, host = HOST): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([digest(host), Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()]);
}

/** macOS/Linux: AES-128-CBC with a fixed IV of spaces. */
function posixBlob(prefix: "v10" | "v11", value: string, key: Buffer, host = HOST): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([digest(host), Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from(prefix), ciphertext]);
}

interface Row {
  host: string;
  name: string;
  encrypted?: Buffer;
  value?: string;
  expires: number;
}

function writeCookieDatabase(path: string, rows: Row[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const inserts = rows
    .map(
      (row) =>
        `INSERT INTO cookies VALUES ('${row.host}', '${row.name}', X'${Buffer.from(row.value ?? "").toString("hex")}', ` +
        `X'${(row.encrypted ?? Buffer.alloc(0)).toString("hex")}', ${row.expires});`,
    )
    .join("\n");
  execFileSync("sqlite3", [
    path,
    `CREATE TABLE cookies (host_key TEXT, name TEXT, value BLOB, encrypted_value BLOB, expires_utc INTEGER);\n${inserts}`,
  ]);
}

/** Builds a Windows-style "User Data" directory: Local State + Default/Network/Cookies. */
function windowsUserData(rows: Row[], options: { appBound?: boolean; key?: Buffer } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pi-lumo-brave-test-"));
  const protectedKey = Buffer.from("dpapi-protected-blob");
  const osCrypt: Record<string, string> = {
    encrypted_key: Buffer.concat([Buffer.from("DPAPI"), protectedKey]).toString("base64"),
  };
  if (options.appBound) osCrypt.app_bound_encrypted_key = Buffer.from("APPB-whatever").toString("base64");
  writeFileSync(join(userData, "Local State"), `\uFEFF${JSON.stringify({ os_crypt: osCrypt })}`);
  const database = join(userData, "Default", "Network", "Cookies");
  writeCookieDatabase(database, rows);
  const key = options.key ?? randomBytes(32);
  const unprotect = (data: Buffer) => {
    assert.deepEqual(data, protectedKey);
    return key;
  };
  return { userData, database, key, unprotect };
}

test("looks for Brave in its macOS, Linux, Flatpak and Snap locations", () => {
  withEnv("LUMO_BRAVE_PROFILE", undefined, () => {
    assert.deepEqual(braveProfileRoots("/Users/t", undefined, "darwin"), [
      join("/Users/t", "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    ]);
    assert.deepEqual(braveProfileRoots("/home/t", "/xdg", "linux"), [
      join("/xdg", "BraveSoftware", "Brave-Browser"),
      join("/home/t", ".var", "app", "com.brave.Browser", "config", "BraveSoftware", "Brave-Browser"),
      join("/home/t", "snap", "brave", "current", ".config", "BraveSoftware", "Brave-Browser"),
    ]);
    assert.ok(braveProfileRoots("/home/t", undefined, "linux").includes(join("/home/t", ".config", "BraveSoftware", "Brave-Browser")));
  });
});

test("looks for Brave's User Data under %LOCALAPPDATA% on Windows", () => {
  withEnv("LUMO_BRAVE_PROFILE", undefined, () => {
    assert.deepEqual(braveProfileRoots("C:/Users/t", undefined, "win32", "C:/Users/t/AppData/Local"), [
      join("C:/Users/t/AppData/Local", "BraveSoftware", "Brave-Browser", "User Data"),
    ]);
    assert.deepEqual(
      profileRootsForBrowser(BRAVE_CONFIG, "C:/Users/t", undefined, "win32", ""),
      [],
      "no LOCALAPPDATA, no Windows root (and never the Linux paths)",
    );
  });
});

test("honors LUMO_BRAVE_PROFILE, and not the Chrome override", () => {
  withEnv("LUMO_CHROME_PROFILE", "/chrome/profile", () =>
    withEnv("LUMO_BRAVE_PROFILE", "/brave/profile", () => {
      const roots = braveProfileRoots("/home/t", undefined, "linux");
      assert.equal(roots[0], "/brave/profile");
      assert.ok(!roots.includes("/chrome/profile"));
    }),
  );
});

test("finds cookie databases in Default and Profile N under User Data", () => {
  const userData = mkdtempSync(join(tmpdir(), "pi-lumo-brave-test-"));
  try {
    writeCookieDatabase(join(userData, "Default", "Network", "Cookies"), []);
    writeCookieDatabase(join(userData, "Profile 2", "Network", "Cookies"), []);
    assert.deepEqual(cookieDatabasesForBrowser([userData]).sort(), [
      join(userData, "Default", "Network", "Cookies"),
      join(userData, "Profile 2", "Network", "Cookies"),
    ]);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("decrypts Windows v10 (AES-256-GCM) values and strips the host digest", () => {
  const key = randomBytes(32);
  assert.equal(decryptWindowsChromiumValue(windowsBlob("opaque", key), key, HOST), "opaque");
  assert.equal(decryptWindowsChromiumValue(windowsBlob("opaque", key), randomBytes(32), HOST), undefined);
  assert.equal(stripHostDigest(Buffer.from("short"), HOST).toString(), "short");
  assert.ok(isAppBoundEncrypted(Buffer.from("v20abc")));
  assert.ok(!isAppBoundEncrypted(Buffer.from("v10abc")));
});

test("reads the DPAPI key and app-bound flag from Local State", () => {
  const json = JSON.stringify({
    os_crypt: { encrypted_key: Buffer.from("DPAPIsecret").toString("base64"), app_bound_encrypted_key: "x" },
  });
  assert.deepEqual(parseLocalState(`\uFEFF${json}`), { encryptedKey: Buffer.from("secret"), appBound: true });
  assert.deepEqual(parseLocalState("not json"), { appBound: false });
});

test("Windows: reads a v10 Brave session, skipping the JWT-shaped AUTH cookie", () => {
  const key = randomBytes(32);
  const { userData, database, unprotect } = windowsUserData(
    [
      { host: HOST, name: "AUTH-uid-1", encrypted: windowsBlob("eyJhbGciOi.jwt", key), expires: 20 },
      { host: HOST, name: "AUTH-uid-1", encrypted: windowsBlob("opaque-token", key), expires: 10 },
      { host: "evillumo.proton.me", name: "AUTH-x", encrypted: windowsBlob("nope", key), expires: 30 },
    ],
    { key },
  );
  try {
    const notes: string[] = [];
    assert.deepEqual(discoverBraveCredentials([database], { platform: "win32", unprotect, note: (n) => notes.push(n) }), {
      uid: "uid-1",
      token: "opaque-token",
      profile: database,
    });
    assert.deepEqual(notes, []);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Windows: explains app-bound (v20) cookies instead of failing silently", () => {
  const { userData, database, unprotect } = windowsUserData(
    [{ host: HOST, name: "AUTH-uid-1", encrypted: Buffer.concat([Buffer.from("v20"), randomBytes(60)]), expires: 1 }],
    { appBound: true },
  );
  try {
    const notes: string[] = [];
    assert.equal(discoverBraveCredentials([database], { platform: "win32", unprotect, note: (n) => notes.push(n) }), undefined);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Brave .*app-bound encryption/);
    assert.match(notes[0], /LUMO_UID and LUMO_TOKEN/);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Windows: an unreadable (locked) cookie file gets an explanation", () => {
  for (const appBound of [true, false]) {
    const { userData, database, unprotect } = windowsUserData([], { appBound });
    try {
      writeFileSync(database, "this is not a sqlite database, like a file Brave holds open");
      const notes: string[] = [];
      assert.equal(discoverBraveCredentials([database], { platform: "win32", unprotect, note: (n) => notes.push(n) }), undefined);
      assert.equal(notes.length, 1);
      assert.match(notes[0], appBound ? /app-bound encryption/ : /locks it while it's running/);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  }
});

test("says when the sqlite3 command is missing, unless app-bound encryption would block it anyway", () => {
  for (const appBound of [false, true]) {
    const { userData, database, unprotect } = windowsUserData([], { appBound });
    try {
      const notes: string[] = [];
      withEnv("PATH", "", () =>
        discoverBraveCredentials([database], { platform: "win32", unprotect, note: (n) => notes.push(n) }),
      );
      assert.equal(notes.length, 1);
      assert.match(notes[0], appBound ? /app-bound encryption/ : /sqlite3 command/);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  }
});

test("Linux: decrypts v11 with the keyring secret and v10 with Chromium's default password", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-lumo-brave-test-"));
  try {
    const keyring = join(directory, "keyring", "Cookies");
    writeCookieDatabase(keyring, [
      { host: HOST, name: "AUTH-uid-11", encrypted: posixBlob("v11", "token-11", deriveChromiumKey("brave-secret", "linux")), expires: 1 },
    ]);
    const basic = join(directory, "basic", "Cookies");
    writeCookieDatabase(basic, [
      { host: HOST, name: "AUTH-uid-10", encrypted: posixBlob("v10", "token-10", deriveChromiumKey("peanuts", "linux")), expires: 1 },
    ]);
    const options = { platform: "linux" as const, safeStoragePassword: () => "brave-secret", note: () => {} };
    assert.deepEqual(discoverBraveCredentials([keyring], options), { uid: "uid-11", token: "token-11", profile: keyring });
    assert.deepEqual(discoverBraveCredentials([basic], options), { uid: "uid-10", token: "token-10", profile: basic });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("macOS: decrypts with the Brave Safe Storage key, and asks for it only when needed", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-lumo-brave-test-"));
  try {
    const database = join(directory, "Default", "Cookies");
    writeCookieDatabase(database, [
      { host: HOST, name: "AUTH-uid-m", encrypted: posixBlob("v10", "token-m", deriveChromiumKey("mac-secret", "darwin")), expires: 1 },
    ]);
    let asked = 0;
    const password = () => {
      asked += 1;
      return "mac-secret";
    };
    assert.deepEqual(discoverBraveCredentials([database], { platform: "darwin", safeStoragePassword: password }), {
      uid: "uid-m",
      token: "token-m",
      profile: database,
    });
    assert.equal(asked, 1);

    const empty = join(directory, "Profile 1", "Cookies");
    writeCookieDatabase(empty, [{ host: "example.com", name: "AUTH-other", value: "x", expires: 1 }]);
    asked = 0;
    assert.equal(discoverBraveCredentials([empty], { platform: "darwin", safeStoragePassword: password }), undefined);
    assert.equal(asked, 0, "no Keychain prompt without an encrypted Lumo cookie");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
