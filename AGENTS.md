# Codex Usage Monitor (GNOME Shell extension)

A GNOME Shell panel indicator that shows your ChatGPT subscription plan and live
Codex usage limits. It reuses the OAuth token that the Codex CLI already stores on
disk (`~/.codex/auth.json`), so there is usually no separate login. When the access
token expires and a refresh token is present, the extension refreshes it automatically
via OpenAI's OAuth endpoint and updates the credential file.

## Layout

The shipped extension lives in `src/`; everything else (this file, the README,
the LICENSE, `build.sh`, `tools/`) is repo tooling that stays out of the bundle.

- `src/extension.js` — panel indicator + dropdown UI (ESM, GNOME Shell 45+ style).
  `ProfileView` holds everything specific to one Codex profile (its `UsageClient`,
  panel block, and popup section); `CodexUsageIndicator` owns one `ProfileView` per
  configured profile, plus the shared panel icon, poll timer, and countdown.
  The panel shows the Codex icon once, then one block per profile: `[profile divider]
  [chip] [tier icon] [tier label] [lead divider]`, then `PanelGroup`s, each
  `[window divider] gauges… [reset countdown]`. There is one `PanelGauge` (tag,
  ring/bar, percentage) per usage window selected by `panel-windows`.
  - Gauges & Meters: dynamically bound to normalized windows returned from Codex.
  - Reset credits: displayed in the dropdown summary under the meters.
  - Tier icons: `src/icons/tier-<name>-symbolic.svg`. Recolored by GNOME Shell in
    the emerald accent color (`#10a37f`).
- `src/prefs.js` — Adwaita preferences (element toggles, "Panel reflects" window
  switches, refresh interval, and the "Codex profiles" list), bound to GSettings,
  on the "General" tab, plus one tab per entry of `UI_PAGES` ("Shared UI",
  "Top-Bar UI", "Popup UI") built by `lib/uiStylePage.js`. Each profile row displays
  CLI sign-in status and guidance.
- `src/schemas/` — GSettings schema (`org.gnome.shell.extensions.codex-usage`).
  Keys: `show-icon`, `show-percentage`, `show-tier`, `show-tier-icon`, `show-reset`,
  `panel-gauge`, `panel-windows`, `panel-divider`, `panel-lead-divider`,
  `poll-seconds`, `panel-position`, `panel-index`, `toggle-menu`, `profiles`,
  `profile-tokens`, `show-profile-chip`, `ui-style`, `profiles-initialized`.
- `src/lib/usageClient.js` — pure GI module: resolves on-disk credentials from
  `~/.codex/auth.json`, parses JWT claims for account/plan details, fetches usage from
  `https://chatgpt.com/backend-api/codex/usage`, and automatically refreshes tokens
  via `https://auth.openai.com/oauth/token` using public CLI client ID
  `app_EMoamEEZ73f0CkXaXp7hrann`. Exports `codexCredentialsAvailable()`,
  `defaultConfigDir()` (`~/.codex`), and `discoverConfigDirs()`.
- `src/lib/profiles.js` — profile list management (`loadProfiles`/`saveProfiles`/
  `ensureProfiles`). Shell-import-free.
- `src/lib/tokenStore.js` — per-profile in-app OAuth token persistence in GSettings.
- `src/lib/uiStyle.js` — declarative table (`UI_STYLE_GROUPS`) covering every
  configurable styling property across "Shared UI", "Top-Bar UI", and "Popup UI"
  tabs. Pure Node/GJS testable without GI.
- `src/lib/uiStylePage.js` — GTK4 / Adwaita preferences page generator for UI styling.
- `src/lib/oauth.js` — shared endpoint URLs, client ID, and text codecs.
- `src/lib/usageModel.js` — pure data-shaping: parses `rate_limit` (deriving window
  durations from `limit_window_seconds`), `model_usage` and `rate_limit_reset_credits`.
- `src/stylesheet.css` — CSS classes (`cu-*`) and theme defaults.
- `src/icons/` — panel icon (`codex-panel.svg`), popup mascot (`codex-mascot.png`),
  and symbolic tier SVGs (`tier-*-symbolic.svg`).
- `build.sh` — packages the extension into `dist/<uuid>.shell-extension.zip`.
- `tools/poll.js` — standalone CLI tool to poll the live Codex endpoint: `gjs -m tools/poll.js`.
- `tools/test-usageModel.mjs` — unit tests for data normalization under plain Node.
- `tools/test-tokenStore.mjs` — unit tests for credential store under plain Node.
- `tools/test-uiStyle.mjs` — unit tests for styling definitions under plain Node.
- `tools/test-uiStylePage.js` — GTK4 in-memory tests for preferences under GJS.
- `tools/compile-schemas.sh` — compiles GSettings schemas for development.

## Data sources

- Credentials: `~/.codex/auth.json` (`tokens.access_token`, `tokens.refresh_token`,
  `tokens.account_id`). JWT claims provide `chatgpt_plan_type` and email.
- Usage: `GET https://chatgpt.com/backend-api/codex/usage`. Returns `rate_limit`
  (`primary_window`, `secondary_window`), `model_usage`, and
  `rate_limit_reset_credits`.
- Account & Profile: `GET https://chatgpt.com/backend-api/me` and
  `GET https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27`.
- Token Refresh: `POST https://auth.openai.com/oauth/token` with
  `grant_type=refresh_token`, `client_id=app_EMoamEEZ73f0CkXaXp7hrann`, and the refresh token.

## Conventions

- All file I/O uses async variants (`_async`) to avoid blocking the GNOME Shell main loop.
- `usageClient.js` and `usageModel.js` remain free of `resource:///org/gnome/shell`
  imports so they can run under plain `gjs` and `node`.
- Never pin a GI version (`import Soup from 'gi://Soup'`).
- Teardown rules: use `connectObject(..., this)`, destroy widgets explicitly, and null references.

## Install (development)

```sh
ln -s "$PWD/src" ~/.local/share/gnome-shell/extensions/codex-usage@o-fgungor.github.io
git config core.hooksPath tools/git-hooks
./tools/compile-schemas.sh
gnome-extensions enable codex-usage@o-fgungor.github.io
```

## Release

`./build.sh` packs `src/` into `dist/<uuid>.shell-extension.zip` for upload to extensions.gnome.org.
