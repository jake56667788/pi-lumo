# pi-lumo (fork)

> **This is a fork of [rebehzat/pi-lumo](https://github.com/rebehzat/pi-lumo).** It fixes the `403 Request rejected by policy` error from [issue #6](https://github.com/rebehzat/pi-lumo/issues/6). The same fix is proposed upstream in [PR #7](https://github.com/rebehzat/pi-lumo/pull/7). Once that's merged, you can switch back to the original.

Use Proton Lumo as a model provider in the [Pi coding agent](https://github.com/badlogic/pi-mono).

## What's different in this fork

- **Sends `lumo.client_type`.** Lumo now blocks every chat request without it. The default is `lumo_desktop`, and you can change it with `LUMO_CLIENT_TYPE` (for example `frontend`) if Proton starts rejecting it.
- **Always sends your UID (`x-pm-uid`).** Without it, Lumo ignores your token and treats you as a guest. If a token is set without `LUMO_UID`, Pi now stops with a clear message instead.
- **Finds your Brave session too**, on macOS and Linux. On Windows it explains why it can't (see [Windows notes](#windows-notes)).
- **Warns when a key saved with `/login` is used instead of `LUMO_TOKEN`** or your browser session, a common cause of `401 "Invalid access token"`.

Everything else works the same as upstream.

## Quick start

1. Install the fork:

   ```bash
   pi install git:github.com/jake56667788/pi-lumo
   ```

2. Sign in at [lumo.proton.me](https://lumo.proton.me/) in Firefox, Chrome, Chromium, Brave, or Safari. On macOS and Linux, pi-lumo usually finds that session automatically. On Windows, set your credentials by hand (step 3) unless you use Firefox.

3. If Pi says `No models available`, set your credentials by hand. See [Extracting credentials from DevTools](#extracting-credentials-from-devtools) for where to find them.

   macOS / Linux:

   ```bash
   export LUMO_UID="<your-id>"        # the part after AUTH- in the cookie name
   export LUMO_TOKEN="<cookie value>" # the full value of that cookie
   ```

   Windows (PowerShell):

   ```powershell
   $env:LUMO_UID="<your-id>"
   $env:LUMO_TOKEN="<cookie value>"
   ```

4. Start Pi with a Lumo model:

   ```bash
   pi --model lumo/lumo-lite
   ```

The rest of this README is the full reference.

## Models

The extension adds three choices to Pi's model picker:

- `lumo/lumo-lite` — Lumo 2.0 Lite
- `lumo/lumo-max` — Lumo 2.0 Max
- `lumo/apertus-15` — Apertus 1.5

Lite and Max support Pi's thinking control. Pi's `off`, `minimal`, `low`, `medium`, `high`, and `xhigh` levels are translated to Lumo's supported reasoning efforts.

## Install

Automatic Firefox, Chrome, Chromium, and Brave authentication require the `sqlite3` command-line tool. It is already installed on many Linux distributions and on macOS; otherwise install your distribution's `sqlite` package. On Windows, `winget install SQLite.SQLite` installs it.

```bash
pi install git:github.com/jake56667788/pi-lumo
```

To try it without installing:

```bash
pi -e git:github.com/jake56667788/pi-lumo
```

## Authenticate

If you are already signed in to Lumo in a supported browser, no setup is normally required. `pi-lumo` searches Firefox, Firefox Developer Edition, Chrome, Chromium, Brave, and (on macOS) Safari profiles at startup, including XDG, Snap, and Flatpak installations on Linux.

| Browser | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Firefox, Firefox Developer Edition | Yes | Yes | Yes, with `sqlite3` installed |
| Chrome | Yes | Yes | No: app-bound encryption (see [Windows notes](#windows-notes)) |
| Brave | Yes | Yes | No: app-bound encryption (see [Windows notes](#windows-notes)) |
| Chromium | Yes | Yes | Only when its cookies aren't app-bound encrypted, and with the browser closed |
| Safari | Yes | — | — |

Authentication precedence is:

1. `LUMO_TOKEN` with `LUMO_UID`, when explicitly set
2. A current Lumo session from Firefox, Firefox Developer Edition, Chrome, Chromium, Brave, or Safari (checked in that order; the first browser with a live session wins)

A key saved with Pi's `/login` overrides both: Pi uses it instead of `LUMO_TOKEN` or the browser session. pi-lumo shows a warning at startup when that happens. To remove the saved key, run `/logout` in Pi and choose Lumo (on recent Pi versions, `pi auth logout lumo` does the same).

Browser credentials are read at runtime and kept in memory. They are never copied into the repository, Pi settings, or an extension-owned credential file. When a browser locks its cookie database, the extension reads a permission-restricted temporary snapshot and deletes it immediately.

Chrome, Chromium, Brave, and Safari encrypt cookie values at rest:

- **Chrome, Chromium, and Brave** each key their encryption off their own per-OS "Safe Storage" password ("Brave Safe Storage" for Brave). On macOS this is read from Keychain via the `security` CLI, which may prompt you to allow access the first time. On Linux it is read via `secret-tool` (from `libsecret`) when available, falling back to Chromium's documented default password otherwise. On Windows, the key is stored in the browser's `Local State` file and protected with Windows DPAPI, which pi-lumo unlocks through Windows PowerShell.
- **Safari** stores cookies in `~/Library/Cookies/Cookies.binarycookies` (or, on newer macOS, inside Safari's sandboxed container). Reading the container path may require granting your terminal or Pi Full Disk Access in System Settings → Privacy & Security.

Lumo does not currently offer users an API key to create or copy. Sign in at [lumo.proton.me](https://lumo.proton.me/) in one of the supported browsers, then start Pi. If Pi cannot find the session, refresh Lumo in your browser and try again.

### Which AUTH cookie is the right one?

Everything below describes **observed behavior as of October 2026**. Lumo's API is unofficial, so Proton may change it at any time.

Signing in to `lumo.proton.me` sets **more than one** `AUTH-*` cookie. They are not interchangeable:

- One holds an encrypted JWT-shaped value starting with `eyJ…`. **It does not work as `LUMO_TOKEN`**, and using it produces `401 "Invalid access token"`.
- Another holds a **shorter, opaque value**. That opaque value is the one Lumo's API accepts.

Two further details matter:

- `LUMO_UID` is the identifier embedded in the **cookie name** — the part after `AUTH-`. It is not the UID shown in `localStorage` or in DevTools request headers.
- `LUMO_TOKEN` is the **entire value** of the working cookie, unmodified. Do not split it, trim it, or take a segment of it.

`localStorage`'s `ps-1` key holds an encrypted blob and cannot be used to recover the token.

### Extracting credentials from DevTools

1. Sign in at [lumo.proton.me](https://lumo.proton.me/).
2. Open DevTools → **Application** → **Cookies** → `https://lumo.proton.me`. (In Firefox the same list lives under **Storage** → **Cookies**.)
3. Find every cookie whose name begins with `AUTH-`. Ignore any whose value begins with `eyJ`.
4. From the remaining cookie, copy the part of the **name** after `AUTH-` and the **whole value**.
5. Export both and start Pi:

```bash
# If the cookie is named AUTH-<your-id>, then:
export LUMO_UID="<your-id>"
export LUMO_TOKEN="<cookie value>"
pi
```

### Common failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Models are listed, but requests fail with `401 "Invalid access token"` | The `eyJ…` AUTH cookie was used, or the session token expired | Use the opaque AUTH cookie; refresh Lumo in the browser and re-copy |
| `401 "Invalid access token"` even with the right `LUMO_TOKEN` and `LUMO_UID`, and a warning that Pi is using a key saved with `/login` | Pi prefers a key saved with `/login` over `LUMO_TOKEN` and over the browser session | Run `/logout` in Pi and choose Lumo, then start Pi again |
| Warning: `pi-lumo found your Brave profile but can't read its Lumo session` | Windows: Brave (like Chrome) protects cookies with app-bound encryption | Set `LUMO_UID` and `LUMO_TOKEN` by hand (see [Windows notes](#windows-notes)) |
| `No models available` | No resolvable credentials: variables unset and no live browser session found | Export `LUMO_UID` and `LUMO_TOKEN`, or sign in to Lumo in a supported browser |
| `403 {"message":"Request rejected by policy.","type":"policy_rejection","code":"blocked_by_policy"}` | Older pi-lumo (or the upstream version before PR #7): Lumo now rejects chat requests whose body has no `lumo.client_type` field | Install this fork. If it still happens, Proton may have blocked the client type: try `LUMO_CLIENT_TYPE=frontend` |
| `Failed to resolve provider "lumo" header "x-pm-uid" from environment variable: LUMO_UID` | A token was supplied without its UID: `LUMO_TOKEN` without `LUMO_UID`, a `LUMO_API_KEY`, or a token saved with Pi's `/login`. Without `x-pm-uid`, Lumo ignores the token | Also export `LUMO_UID` (the part after `AUTH-` in the cookie name) |
| Models work in one shell, then vanish in another | The exports were typed into a shell but never persisted | Add the exports to `~/.zshrc`, `~/.bashrc`, or your shell's equivalent |

### macOS notes

- Reading Safari's sandboxed cookie container requires **Full Disk Access** for your terminal or Pi (System Settings → Privacy & Security → Full Disk Access).
- Reading Chrome's, Chromium's, or Brave's "Safe Storage" password from Keychain triggers a **one-time Keychain access prompt**; approving it lets `pi-lumo` decrypt cookie values. Declining leaves that browser source unusable.

### Windows notes

On Windows, Chrome (since version 127) and Brave protect cookies with **app-bound encryption**: their cookie values start with `v20`, and the key can only be unlocked by the browser's own elevation service, which runs as SYSTEM. Other programs, pi-lumo included, can't decrypt them without running as administrator or injecting code into the browser, and pi-lumo doesn't do either. When it finds such a profile, it shows a warning at startup and you set your credentials by hand instead:

```powershell
$env:LUMO_UID="<your-id>"          # the part after AUTH- in the cookie name
$env:LUMO_TOKEN="<cookie value>"   # the full value of the cookie that doesn't start with eyJ
pi --model lumo/lumo-lite
```

`$env:` only lasts for that terminal window. To keep the values, run `setx LUMO_UID "<your-id>"` and `setx LUMO_TOKEN "<cookie value>"` once, then open a new terminal. If you used `/login` for Lumo earlier, run `/logout` in Pi and choose Lumo first, or the saved key keeps overriding these values.

Older `v10` cookies (and Chromium builds without app-bound encryption) are decrypted with the DPAPI-protected key from the browser's `Local State` file. Chromium-family browsers on Windows also lock their cookie file while they run, so this only works with the browser fully closed. Firefox works on Windows with `sqlite3` installed.

### Manual session variables

For compatibility with [lumode](https://github.com/rebehzat/lumode), the extension also recognizes its existing session credentials:

```bash
export LUMO_UID="<your-id>"          # the part after AUTH- in the cookie name
export LUMO_TOKEN="<cookie value>"   # the full value of the opaque AUTH cookie
pi
```

Manual session variables take precedence over automatic browser discovery. Session authentication relies on Proton's private web behavior and may break when Proton changes it.

### Browser profile overrides

Set these if your profile lives in a custom location. Each may point directly to a profile directory, or to a directory containing multiple profiles.

```bash
export LUMO_FIREFOX_PROFILE="/path/to/firefox/profile"      # contains cookies.sqlite
export LUMO_CHROME_PROFILE="/path/to/chrome/profile"        # contains Cookies or Network/Cookies
export LUMO_CHROMIUM_PROFILE="/path/to/chromium/profile"    # contains Cookies or Network/Cookies
export LUMO_BRAVE_PROFILE="/path/to/brave/profile"          # contains Cookies or Network/Cookies
export LUMO_SAFARI_COOKIES="/path/to/Cookies.binarycookies" # points directly at the file
pi
```

Firefox-fork browsers such as Zen Browser and LibreWolf store cookies in Firefox's format, so they work through `LUMO_FIREFOX_PROFILE` — point it at the fork's profile directory containing `cookies.sqlite`.

### Client type override

This fork tells Lumo it is the desktop app (`lumo_desktop`). This value isn't documented by Proton, so it could stop working. If requests start failing with the 403 above, try another value without waiting for an update:

```bash
export LUMO_CLIENT_TYPE="frontend"   # PowerShell: $env:LUMO_CLIENT_TYPE="frontend"
pi
```

## Select a model

Inside Pi, open `/model` and search for `lumo`, or launch a model directly:

```bash
pi --model lumo/lumo-lite
pi --model lumo/lumo-max --thinking high
pi --model lumo/apertus-15
```

You can also cycle only among the three Lumo models:

```bash
pi --models "lumo/*"
```

Verify that Pi loaded all choices:

```bash
pi --list-models lumo
```

## Development

```bash
npm install
npm run check
npm test
```

The provider uses Lumo's OpenAI-compatible endpoint at `https://lumo.proton.me/api/ai/v1` with streaming, image input on Lite and Max, function tools, and a 128k context window.

## Notes

- This extension uses Lumo's private web API and your existing browser session. Proton may change either without notice.
- Apertus 1.5 availability may depend on Proton's rollout and your account.
- Usage limits and plan restrictions are enforced by Proton.
- This is an unofficial community extension and is not affiliated with Proton AG.

## License

MIT
