# Codex Usage Monitor

<img width="260" alt="Codex Usage Monitor" align="right" src="assets/codex-mascot.png" />

A GNOME Shell panel indicator that shows your ChatGPT subscription plan and live
Codex usage limits right in the top bar, so you can see your remaining quota windows
without opening a browser.

This project is adapted from [ClaudeCodeUsage](https://github.com/dvdstelt/ClaudeCodeUsage), originally created by **Dennis van der Stelt** ([@dvdstelt](https://github.com/dvdstelt)) and contributors.

Built with virtually identical layouts, gauge styling, and theme customization options as its companion extensions:
- **[Claude Code Usage Monitor](https://github.com/dvdstelt/ClaudeCodeUsage)** (for Claude Code)
- **[Antigravity Usage Monitor](https://github.com/o-fgungor/antigravity-usage)** (for Google Antigravity / Gemini)

When installed together, they share a harmonized visual language to provide a seamless, unified indicator display across your GNOME panel.

It reuses the OAuth credentials that the Codex CLI already stores on disk
(`~/.codex/auth.json`), so for most people there is nothing extra to log in to.
When a refresh token is present and the access token expires, the extension
refreshes it automatically via OpenAI's OAuth endpoint and updates the credential
file.

> [!NOTE]
> **What changed?** See the [changelog](CHANGELOG.md) for notable changes in each release.

See [install](#install) instructions

<br /><br />

## Features

- **Panel indicator** with a Codex icon, a usage gauge (a circular ring or a horizontal bar, your choice, or none), a percentage, an optional time-until-reset countdown, and the subscription tier badge (Plus, Team, Pro, Enterprise, Free). Each element can be toggled independently.
- **Multiple profiles.** If you run more than one Codex configuration on this machine, the extension shows configured profiles side by side in the panel and dropdown, and refreshes them together.
- **Dropdown** with per-window meters: short rolling windows, long rolling windows, model-specific limits reported by OpenAI, rate limit reset credits, and rate projection.
- **Rate projection.** Meters, the ring, and the panel percentage are colored by your projected end-of-window usage at the current burn rate, so a fast burn turns amber or red before you actually hit the limit.
- **Live countdown.** The "resets in" captions tick down between polls, counting in seconds once a window is less than a minute from resetting.
- **Themeable.** The gauge track is a neutral grey that reads on both light and dark themes, and every color, size, spacing and font in the panel and the popup can be changed from the UI preference tabs.
- **Configurable** refresh interval and choice of which windows the panel shows: short window, long window, model limits, whichever is most constrained, or the worst active limit, side by side.

## Requirements

- GNOME Shell 46, 47, 48, 49, or 50 (Ubuntu 24.04 LTS and newer).
- An active ChatGPT account / Codex CLI installation with credentials at `~/.codex/auth.json` (run `codex login` if not already signed in).

## Install

### From source (development)

The extension source lives in `src/`. Symlink that directory into the GNOME extensions folder:

```sh
git clone https://github.com/o-fgungor/codex-usage.git
cd codex-usage
ln -s "$PWD/src" \
  ~/.local/share/gnome-shell/extensions/codex-usage@o-fgungor.github.io
git config core.hooksPath tools/git-hooks
./tools/compile-schemas.sh
gnome-extensions enable codex-usage@o-fgungor.github.io
```

The `core.hooksPath` line keeps the compiled GSettings schema in step with
whatever branch you have checked out. The extensions folder symlinks `src/`, so
the code follows a branch switch instantly, but the compiled schema is a
gitignored build artifact — without the hooks, checking out a branch that adds a
setting leaves the extension failing to start with `GSettings key … not found in
schema`. Run `./tools/compile-schemas.sh` any time to fix that by hand.

On Wayland a newly installed extension only loads after you log out and back in.
On X11 you can reload the shell with `Alt+F2`, then `r`, then Enter.

## Configuration

Open the preferences from the dropdown (the gear button) or with:

```sh
gnome-extensions prefs codex-usage@o-fgungor.github.io
```

- **Panel elements** — show or hide the Codex icon, percentage, time until reset, subscription tier label, and subscription tier icon, and choose the usage gauge (circle, bar, or none).
- **Panel reflects** — which windows get a gauge (ring or bar, percentage, time-until-reset countdown) in the panel. Switch on any combination of the short window, long window, model limits, whichever window is most constrained, and the worst active limit.
- **Panel position** — which section of the top bar the indicator sits in (left, center, or right), and where it sits among the other items there. Changes apply immediately.
- **Shortcut to open the popup** — an optional keyboard shortcut that opens and closes the usage dropdown.
- **Refresh interval** — how often to poll for updated usage (30 to 600 seconds; default 300).

Three more tabs hold the look of the extension: **Shared UI** for what the top bar and the popup have in common, **Top-Bar UI** for the indicator in the top bar, and **Popup UI** for the popup that opens from it. Between them they cover the sizes, spacing, padding, font sizes and weights, corner radii and colors in use. Changes apply immediately. A value you changed gets a reset button next to it, and a **Reset all** button at the top of that tab restores its defaults.

## Authentication

The extension **never asks for your password**. It reads the access and refresh tokens stored by the official Codex CLI in `~/.codex/auth.json`.

When the access token approaches expiration, the extension automatically requests a refreshed access token from OpenAI's OAuth endpoint and writes the updated credentials back to `~/.codex/auth.json`, so your session remains active seamlessly.

## Development

See `AGENTS.md` for architecture details, data sources, and conventions.

Run test suite:

```sh
# Verify live API connection and display current usage
gjs -m tools/poll.js

# Run unit tests
node tools/test-tokenStore.mjs
node tools/test-uiStyle.mjs
node tools/test-usageModel.mjs
gjs -m tools/test-uiStylePage.js
```

## Credits and Contributors

Adapted for OpenAI Codex / ChatGPT by [Ömer Faruk Güngör](https://github.com/o-fgungor).

This extension is based on and derived from [ClaudeCodeUsage](https://github.com/dvdstelt/ClaudeCodeUsage) by **Dennis van der Stelt** ([@dvdstelt](https://github.com/dvdstelt)) and contributors:

- **Dennis van der Stelt** ([@dvdstelt](https://github.com/dvdstelt)) — creator of ClaudeCodeUsage, architecture and core implementation
- [@shiznatix](https://github.com/shiznatix) — multi-window panel layout and extensive Adwaita UI styling system
- [@amalakhovsky](https://github.com/amalakhovsky), [@ClemDNL](https://github.com/ClemDNL), [@rafi0x](https://github.com/rafi0x) — dynamic meters, live countdown, and profile management

Pull requests are welcome. See `AGENTS.md` for guidelines and conventions.

## License

Released under the GNU General Public License, version 2 or later (GPL-2.0-or-later). See `LICENSE` for the full text.

## Disclaimer

This is an unofficial, community project. It is not affiliated with or endorsed by OpenAI, Anthropic, or the ClaudeCodeUsage authors. It relies on internal endpoints that may change at any time.
