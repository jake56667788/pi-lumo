import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import lumoProvider, {
  BASE_URL,
  discoverBrowserCredentials,
  getAuthConfig,
  hasSavedLoginKey,
  LUMO_MODELS,
  piAuthFile,
  PROVIDER_ID,
  startupWarnings,
} from "../index.js";

test("exports all three current Lumo choices", () => {
  assert.deepEqual(
    LUMO_MODELS.map(({ id, name }) => ({ id, name })),
    [
      { id: "lumo-lite", name: "Lumo 2.0 Lite" },
      { id: "lumo-max", name: "Lumo 2.0 Max" },
      { id: "apertus-15", name: "Apertus 1.5" },
    ],
  );
});

test("registers an OpenAI-compatible provider using LUMO_API_KEY", () => {
  let registeredName: string | undefined;
  let registeredConfig: Record<string, unknown> | undefined;
  let requestHandler: ((event: { payload: unknown }, ctx: { model?: { provider: string } }) => unknown) | undefined;
  const pi = {
    registerProvider(name: string, config: Record<string, unknown>) {
      registeredName = name;
      registeredConfig = config;
    },
    on(event: string, handler: typeof requestHandler) {
      if (event === "before_provider_request") requestHandler = handler;
    },
  };

  const previousApiKey = process.env.LUMO_API_KEY;
  process.env.LUMO_API_KEY = "test";
  try {
    lumoProvider(pi as never);
  } finally {
    if (previousApiKey === undefined) delete process.env.LUMO_API_KEY;
    else process.env.LUMO_API_KEY = previousApiKey;
  }

  assert.equal(registeredName, PROVIDER_ID);
  assert.equal(registeredConfig?.baseUrl, BASE_URL);
  assert.equal(registeredConfig?.apiKey, "$LUMO_API_KEY");
  assert.deepEqual(registeredConfig?.headers, { "x-pm-uid": "$LUMO_UID" });
  assert.equal(registeredConfig?.authHeader, true);
  assert.equal(registeredConfig?.api, "openai-completions");
  assert.equal((registeredConfig?.models as unknown[]).length, 3);

  // Lumo answers 403 blocked_by_policy unless the body names a client type.
  const body = { model: "lumo-lite", messages: [] };
  assert.deepEqual(requestHandler?.({ payload: body }, { model: { provider: PROVIDER_ID } }), {
    ...body,
    lumo: { client_type: "lumo_desktop" },
  });
  assert.equal(requestHandler?.({ payload: body }, { model: { provider: "openai" } }), undefined);
});

test("maps Pi thinking levels to Lumo reasoning efforts", () => {
  const lite = LUMO_MODELS.find((model) => model.id === "lumo-lite");
  const max = LUMO_MODELS.find((model) => model.id === "lumo-max");
  const apertus = LUMO_MODELS.find((model) => model.id === "apertus-15");

  assert.deepEqual(lite?.thinkingLevelMap, {
    off: "none",
    minimal: "none",
    low: "medium",
    medium: "medium",
    high: "high",
    xhigh: "max",
  });
  assert.deepEqual(max?.thinkingLevelMap, lite?.thinkingLevelMap);
  assert.equal(apertus?.reasoning, false);
});

test("supports the session-token environment used by lumode", () => {
  assert.deepEqual(getAuthConfig({ LUMO_TOKEN: "secret", LUMO_UID: "uid" }), {
    apiKey: "$LUMO_TOKEN",
    headers: { "x-pm-uid": "$LUMO_UID" },
  });
  assert.deepEqual(
    getAuthConfig({ LUMO_API_KEY: "official", LUMO_TOKEN: "legacy", LUMO_UID: "uid" }),
    { apiKey: "$LUMO_API_KEY", headers: { "x-pm-uid": "$LUMO_UID" } },
  );
});

// Lumo answers any request without x-pm-uid with 403 "blocked_by_policy" (issue #6).
// Every token source must therefore carry a UID header; when it comes from LUMO_UID
// and that is unset, Pi fails with "Failed to resolve ... from environment variable: LUMO_UID".
test("always requires x-pm-uid, even when LUMO_UID is missing", () => {
  const noBrowser = () => undefined;

  assert.deepEqual(getAuthConfig({ LUMO_TOKEN: "secret" }, noBrowser), {
    apiKey: "$LUMO_TOKEN",
    headers: { "x-pm-uid": "$LUMO_UID" },
  });
  assert.deepEqual(getAuthConfig({ LUMO_API_KEY: "key" }, noBrowser), {
    apiKey: "$LUMO_API_KEY",
    headers: { "x-pm-uid": "$LUMO_UID" },
  });
  // Nothing configured: a key saved with Pi's /login takes over apiKey, so the UID header must still be present.
  assert.deepEqual(getAuthConfig({}, noBrowser), {
    apiKey: "$LUMO_API_KEY",
    headers: { "x-pm-uid": "$LUMO_UID" },
  });
});

test("uses discovered browser credentials only when environment credentials are absent", () => {
  const discover = () => ({ uid: "browser-uid", token: "browser-token", profile: "/profile/cookies.sqlite" });

  assert.deepEqual(getAuthConfig({}, discover), {
    apiKey: "browser-token",
    headers: { "x-pm-uid": "browser-uid" },
  });
  assert.deepEqual(getAuthConfig({ LUMO_API_KEY: "official" }, discover), {
    apiKey: "$LUMO_API_KEY",
    headers: { "x-pm-uid": "$LUMO_UID" },
  });
});

test("discoverBrowserCredentials tries each browser in order until one succeeds", () => {
  const calls: string[] = [];
  const credentials = discoverBrowserCredentials([
    () => {
      calls.push("firefox");
      return undefined;
    },
    () => {
      calls.push("chrome");
      return { uid: "chrome-uid", token: "chrome-token", profile: "/profile/Cookies" };
    },
    () => {
      calls.push("safari");
      return { uid: "safari-uid", token: "safari-token", profile: "/profile/Cookies.binarycookies" };
    },
  ]);

  assert.deepEqual(calls, ["firefox", "chrome"]);
  assert.deepEqual(credentials, { uid: "chrome-uid", token: "chrome-token", profile: "/profile/Cookies" });
});

test("discoverBrowserCredentials survives a browser discoverer that throws", () => {
  const credentials = discoverBrowserCredentials([
    () => {
      throw new Error("locked profile");
    },
    () => ({ uid: "safari-uid", token: "safari-token", profile: "/profile/Cookies.binarycookies" }),
  ]);

  assert.deepEqual(credentials, { uid: "safari-uid", token: "safari-token", profile: "/profile/Cookies.binarycookies" });
});

test("discoverBrowserCredentials() wires up Firefox, Chrome, Chromium, Brave, and Safari by default without throwing", () => {
  assert.doesNotThrow(() => discoverBrowserCredentials());
});

test("finds the auth.json that Pi's /login writes to", () => {
  assert.equal(piAuthFile({}, "/home/t"), join("/home/t", ".pi", "agent", "auth.json"));
  assert.equal(piAuthFile({ PI_CODING_AGENT_DIR: "/custom/agent" }, "/home/t"), join("/custom/agent", "auth.json"));
  assert.equal(piAuthFile({ PI_CODING_AGENT_DIR: "~/agent" }, "/home/t"), join("/home/t", "agent", "auth.json"));

  const directory = mkdtempSync(join(tmpdir(), "pi-lumo-auth-test-"));
  try {
    const file = join(directory, "auth.json");
    assert.equal(hasSavedLoginKey(file), false, "missing file");
    writeFileSync(file, JSON.stringify({ openai: { type: "api_key", key: "k" } }));
    assert.equal(hasSavedLoginKey(file), false);
    writeFileSync(file, `\uFEFF${JSON.stringify({ lumo: { type: "api_key", key: "k" } })}`);
    assert.equal(hasSavedLoginKey(file), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("warns when a key saved with /login replaces LUMO_TOKEN or the browser session", () => {
  const fromEnv = { apiKey: "$LUMO_TOKEN" };
  const fromBrowser = { apiKey: "browser-token" };

  assert.match(startupWarnings({ LUMO_TOKEN: "t", LUMO_UID: "u" }, fromEnv, [], true)[0], /instead of LUMO_TOKEN.*\/logout/);
  assert.match(startupWarnings({}, fromBrowser, [], true)[0], /instead of your browser session/);
  assert.deepEqual(startupWarnings({ LUMO_TOKEN: "t", LUMO_UID: "u" }, fromEnv, [], false), []);
  assert.deepEqual(startupWarnings({ LUMO_API_KEY: "k" }, { apiKey: "$LUMO_API_KEY" }, [], true), []);
});

test("shows browser discovery notes only when nothing else supplies a login", () => {
  const note = "pi-lumo found your Brave profile but can't read its Lumo session";
  const nothing = { apiKey: "$LUMO_API_KEY" };

  assert.deepEqual(startupWarnings({}, nothing, [note], false), [note]);
  assert.deepEqual(startupWarnings({ LUMO_TOKEN: "t", LUMO_UID: "u" }, { apiKey: "$LUMO_TOKEN" }, [note], false), []);
  assert.deepEqual(startupWarnings({ LUMO_UID: "u" }, nothing, [note], false), []);
  assert.deepEqual(startupWarnings({}, { apiKey: "firefox-token" }, [note], false), []);
});
