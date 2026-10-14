// Shared OAuth / API constants and small text-codec helpers, imported by both
// the usage client and preferences so the values live in one place. Keep this
// free of `resource:///org/gnome/shell` imports so it stays usable from prefs
// (and plain gjs) as well as the shell.

// Public OAuth client id of the Codex CLI application.
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// API endpoints.
export const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage';
export const ACCOUNTS_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';
export const ME_URL = 'https://chatgpt.com/backend-api/me';
export const SUBSCRIPTION_URL = 'https://chatgpt.com/#settings/Subscription';

// User-Agent sent with requests.
export const USER_AGENT = 'codex-cli/0.144.6';

// Default OAuth access-token lifetime (10 days) when the token endpoint
// omits expires_in.
export const DEFAULT_EXPIRES_IN = 864000;

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
