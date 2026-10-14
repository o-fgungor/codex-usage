# Changelog

All notable changes to Codex Usage Monitor are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.0.0 - 2026-10-14

Initial release of Codex Usage Monitor, adapted from Claude Code Usage Monitor for OpenAI Codex CLI and ChatGPT accounts.

### Added
- Panel indicator with a custom Codex icon, usage gauge (circular ring, horizontal bar, or none), usage percentage, time-until-reset countdown, and subscription tier badge (`Plus`, `Team`, `Pro`, `Free`, etc.).
- Dropdown menu showing reported rolling quota windows (primary short window, secondary long window, and scoped model limits), reset countdowns, rate projection, and rate limit reset credits.
- Dynamic duration labels: window duration is derived directly from `limit_window_seconds` reported by OpenAI's Codex backend rather than assuming fixed windows.
- Automatic credential discovery reading `~/.codex/auth.json` with seamless access token refresh using OpenAI's OAuth endpoint when refresh tokens are available.
- Multiple profile support to track multiple Codex configurations side by side.
- Comprehensive UI customization with "Shared UI", "Top-Bar UI", and "Popup UI" tabs in preferences to customize colors, font sizes, gauge geometry, padding, and dividers.
- Standalone validation tooling (`tools/poll.js`, `tools/test-usageModel.mjs`, `tools/test-tokenStore.mjs`, `tools/test-uiStyle.mjs`, `tools/test-uiStylePage.js`).
