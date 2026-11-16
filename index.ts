import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverBraveCredentials } from "./brave-auth.ts";
import { discoverChromeCredentials } from "./chrome-auth.ts";
import { discoverChromiumCredentials } from "./chromium-auth.ts";
import { takeDiscoveryNotes } from "./discovery-notes.ts";
import { discoverFirefoxCredentials } from "./firefox-auth.ts";
import { discoverSafariCredentials } from "./safari-auth.ts";

interface BrowserCredentials {
  uid: string;
  token: string;
  profile: string;
}

/** Tries each supported browser in turn; the first live Lumo session wins. */
export function discoverBrowserCredentials(
  discoverers: Array<() => BrowserCredentials | undefined> = [
    discoverFirefoxCredentials,
    discoverChromeCredentials,
    discoverChromiumCredentials,
    discoverBraveCredentials,
    discoverSafariCredentials,
  ],
): BrowserCredentials | undefined {
  for (const discover of discoverers) {
    try {
      const credentials = discover();
      if (credentials) return credentials;
    } catch {
      // An unsupported or inaccessible browser should not prevent Pi startup.
    }
  }
  return undefined;
}

export const PROVIDER_ID = "lumo";
export const BASE_URL = "https://lumo.proton.me/api/ai/v1";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const REASONING_LEVELS = {
  off: "none",
  minimal: "none",
  low: "medium",
  medium: "medium",
  high: "high",
  xhigh: "max",
} as const;

/** Models currently selectable in the Lumo app. */
export const LUMO_MODELS = [
  {
    id: "lumo-lite",
    name: "Lumo 2.0 Lite",
    reasoning: true,
    thinkingLevelMap: REASONING_LEVELS,
    input: ["text", "image"] as const,
    cost: FREE,
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { supportsReasoningEffort: true, supportsDeveloperRole: false },
  },
  {
    id: "lumo-max",
    name: "Lumo 2.0 Max",
    reasoning: true,
    thinkingLevelMap: REASONING_LEVELS,
    input: ["text", "image"] as const,
    cost: FREE,
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { supportsReasoningEffort: true, supportsDeveloperRole: false },
  },
  {
    id: "apertus-15",
    name: "Apertus 1.5",
    reasoning: false,
    input: ["text"] as const,
    cost: FREE,
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { supportsDeveloperRole: false },
  },
] as const;

/**
 * Without an `x-pm-uid` header Lumo ignores the token and treats the request
 * as an anonymous guest. So every token source is paired with a UID. When the UID has to come
 * from `LUMO_UID` and it is unset, Pi refuses to send the request and names the
 * missing variable, instead of letting Lumo answer with an opaque 403.
 */
const UID_FROM_ENV = { "x-pm-uid": "$LUMO_UID" } as const;

export function getAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  discover: () => BrowserCredentials | undefined = discoverBrowserCredentials,
): {
  apiKey: string;
  headers: Record<string, string>;
} {
  if (!env.LUMO_API_KEY && env.LUMO_TOKEN) {
    return { apiKey: "$LUMO_TOKEN", headers: { ...UID_FROM_ENV } };
  }

  if (!env.LUMO_API_KEY) {
    const credentials = discover();
    if (credentials) {
      return {
        apiKey: credentials.token,
        headers: {
          "x-pm-uid": credentials.uid,
        },
      };
    }
  }

  // LUMO_API_KEY, or a key saved with Pi's /login (which Pi prefers over
  // apiKey): either way Lumo still needs the UID.
  return { apiKey: "$LUMO_API_KEY", headers: { ...UID_FROM_ENV } };
}

/** Path of the auth.json Pi's /login writes to (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
export function piAuthFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR;
  const agentDir = configured
    ? configured === "~"
      ? home
      : configured.startsWith("~/") || configured.startsWith("~\\")
        ? join(home, configured.slice(2))
        : configured
    : join(home, ".pi", "agent");
  return join(agentDir, "auth.json");
}

/** True when Pi has a Lumo key saved with /login, which Pi uses instead of the provider's own key. */
export function hasSavedLoginKey(authFile = piAuthFile()): boolean {
  try {
    const saved = JSON.parse(readFileSync(authFile, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return Boolean(saved && typeof saved === "object" && saved[PROVIDER_ID]);
  } catch {
    return false;
  }
}

/**
 * Warnings shown once at startup, for setups that otherwise fail with an
 * unexplained 401/403 later:
 * - a key saved with /login silently replaces LUMO_TOKEN or the browser session;
 * - a browser profile exists but its Lumo session can't be read (e.g. Brave on Windows).
 */
export function startupWarnings(
  env: NodeJS.ProcessEnv,
  auth: { apiKey: string },
  notes: string[],
  savedLoginKey: boolean,
): string[] {
  const warnings: string[] = [];
  const fromBrowser = !auth.apiKey.startsWith("$");

  if (savedLoginKey && !env.LUMO_API_KEY && (env.LUMO_TOKEN || fromBrowser)) {
    warnings.push(
      `pi-lumo: Pi is using a Lumo key saved with /login instead of ${env.LUMO_TOKEN ? "LUMO_TOKEN" : "your browser session"}. ` +
        "If Lumo answers 401 Invalid access token, run /logout in Pi and choose Lumo to remove the saved key.",
    );
  }

  if (!fromBrowser && !savedLoginKey && !env.LUMO_TOKEN && !env.LUMO_API_KEY && !env.LUMO_UID) {
    warnings.push(...notes);
  }

  return warnings;
}

export default function lumoProvider(pi: ExtensionAPI): void {
  if (process.env.PI_LUMO_DEBUG) console.error("pi-lumo: extension loaded");
  const auth = getAuthConfig();
  const warnings = startupWarnings(process.env, auth, takeDiscoveryNotes(), hasSavedLoginKey());
  if (process.env.PI_LUMO_DEBUG) for (const warning of warnings) console.error(warning);

  pi.registerProvider(PROVIDER_ID, {
    name: "Proton Lumo",
    baseUrl: BASE_URL,
    ...auth,
    authHeader: true,
    api: "openai-completions",
    models: LUMO_MODELS.map((model) => ({
      ...model,
      input: [...model.input],
    })),
  });

  // Lumo rejects chat requests whose body has no `lumo.client_type` with
  // 403 blocked_by_policy, signed in or not; `client_type: "api"` is rejected
  // the same way for session tokens.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return undefined;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return undefined;
    const lumo = (payload.lumo as Record<string, unknown> | undefined) ?? {};
    return { ...payload, lumo: { client_type: LUMO_CLIENT_TYPE, ...lumo } };
  });

  if (warnings.length > 0) {
    let shown = false;
    pi.on("session_start", (_event, ctx) => {
      if (shown) return;
      shown = true;
      try {
        for (const warning of warnings) ctx.ui.notify(warning, "warning");
      } catch {
        // No UI (e.g. print mode): the warnings are informational only.
      }
    });
  }
}

export const LUMO_CLIENT_TYPE = process.env.LUMO_CLIENT_TYPE || "lumo_desktop";
