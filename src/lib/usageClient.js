import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {getToken, setToken, migrateLegacyToken} from './tokenStore.js';
import {
    TOKEN_URL, USAGE_URL, ACCOUNTS_URL, ME_URL, SUBSCRIPTION_URL,
    CLIENT_ID, USER_AGENT, DEFAULT_EXPIRES_IN,
    encoder, decoder,
} from './oauth.js';

// Refresh when the token expires within this many milliseconds.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// Default Codex config directory, used when a profile does not specify its own.
export function defaultConfigDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

function candidateTokenPaths(configDir) {
    return [
        GLib.build_filenamev([configDir, 'auth.json']),
    ];
}

export async function discoverConfigDirs() {
    const defaultDir = defaultConfigDir();
    const found = [];
    if (await readCredentialsRoot(defaultDir))
        found.push({name: 'Codex', configDir: defaultDir});

    if (found.length === 0)
        found.push({name: 'Codex', configDir: defaultDir});

    return found;
}

function parseJwtClaims(token) {
    try {
        if (!token || typeof token !== 'string')
            return null;
        const parts = token.split('.');
        if (parts.length < 2)
            return null;
        let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4 !== 0)
            payload += '=';
        const decoded = GLib.base64_decode(payload);
        return JSON.parse(decoder.decode(decoded));
    } catch {
        return null;
    }
}

// Reads and parses on-disk credentials asynchronously.
async function readCredentialsRoot(configDir) {
    const paths = candidateTokenPaths(configDir);
    for (const path of paths) {
        try {
            const file = Gio.File.new_for_path(path);
            const bytes = await new Promise(resolve => {
                file.load_contents_async(null, (f, res) => {
                    try {
                        const [ok, data] = f.load_contents_finish(res);
                        resolve(ok ? data : null);
                    } catch {
                        resolve(null);
                    }
                });
            });
            if (!bytes)
                continue;

            const text = decoder.decode(bytes);
            const root = JSON.parse(text);

            const tokenObj = root?.tokens;
            if (tokenObj?.access_token) {
                const claims = parseJwtClaims(tokenObj.access_token);
                const expiresAt = claims?.exp ? claims.exp * 1000 : 0;
                const authClaims = claims?.['https://api.openai.com/auth'] || {};
                const profileClaims = claims?.['https://api.openai.com/profile'] || {};

                return {
                    accessToken: tokenObj.access_token,
                    refreshToken: tokenObj.refresh_token || '',
                    idToken: tokenObj.id_token || '',
                    accountId: tokenObj.account_id || authClaims.chatgpt_account_id || '',
                    planType: authClaims.chatgpt_plan_type || 'free',
                    email: profileClaims.email || '',
                    expiresAt,
                    format: 'codex-auth',
                    filePath: path,
                    rawRoot: root,
                };
            }
        } catch {
            // Try next candidate
        }
    }
    return null;
}

export async function codexCredentialsAvailable(configDir = defaultConfigDir()) {
    const creds = await readCredentialsRoot(configDir);
    if (!creds)
        return false;
    return Boolean(creds.accessToken || creds.refreshToken);
}

export const chatgptCredentialsAvailable = codexCredentialsAvailable;

export class UsageError extends Error {
    constructor(message, {status = 0, body = ''} = {}) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
        this.body = body;
    }

    apiMessage() {
        try {
            const parsed = JSON.parse(this.body);
            return parsed?.error?.message || parsed?.detail || null;
        } catch {
            return null;
        }
    }
}

export class SignedOutError extends UsageError {
    constructor(message = 'Not signed in for this profile.') {
        super(message);
        this.name = 'SignedOutError';
        this.signedOut = true;
    }
}

export class UsageClient {
    constructor({configDir = defaultConfigDir(), settings = null, allowSharedToken = true, profileId = null} = {}) {
        this._configDir = configDir;
        this._settings = settings;
        this._allowSharedToken = allowSharedToken;
        this._profileId = profileId;
        this._session = new Soup.Session();
        this._session.set_user_agent(USER_AGENT);
        this._tokenPromise = null;
        this._lastAccountId = '';
    }

    async _writeCredentials(filePath, rawRoot) {
        const file = Gio.File.new_for_path(filePath);
        const text = JSON.stringify(rawRoot, null, 2);
        const bytes = new GLib.Bytes(encoder.encode(text));
        return new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(
                bytes, null, false, Gio.FileCreateFlags.NONE, null,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _request(method, url, {token = null, accountId = null, formBody = null, jsonBody = null, cancellable = null} = {}) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new(method, url);
            if (!msg) {
                reject(new UsageError(`Invalid URL: ${url}`));
                return;
            }

            msg.request_headers.append('User-Agent', USER_AGENT);
            msg.request_headers.append('Accept', 'application/json');

            if (token)
                msg.request_headers.append('Authorization', `Bearer ${token}`);
            if (accountId)
                msg.request_headers.append('chatgpt-account-id', accountId);

            if (formBody) {
                const raw = encoder.encode(formBody);
                msg.set_request_body_from_bytes('application/x-www-form-urlencoded', new GLib.Bytes(raw));
            } else if (jsonBody) {
                const raw = encoder.encode(JSON.stringify(jsonBody));
                msg.set_request_body_from_bytes('application/json', new GLib.Bytes(raw));
            }

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        reject(new UsageError(`HTTP ${status} from ${url}`, {status, body: text}));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _exchangeRefreshToken(refreshToken) {
        let data;
        try {
            const formBody = `client_id=${encodeURIComponent(CLIENT_ID)}` +
                `&grant_type=refresh_token` +
                `&refresh_token=${encodeURIComponent(refreshToken)}`;

            data = await this._request('POST', TOKEN_URL, {formBody});
        } catch (e) {
            if (e instanceof UsageError && (e.status === 400 || e.status === 401))
                throw new UsageError('Session expired; please run `codex` to sign in again',
                    {status: 401, body: e.body});
            throw e;
        }
        if (!data.access_token)
            throw new UsageError('Refresh response missing access_token', {body: JSON.stringify(data)});
        return data;
    }

    async _refreshFileToken(creds) {
        const data = await this._exchangeRefreshToken(creds.refreshToken);
        const expiresInSec = data.expires_in ?? DEFAULT_EXPIRES_IN;
        const newExpiryMs = Date.now() + expiresInSec * 1000;

        if (creds.rawRoot?.tokens) {
            creds.rawRoot.tokens.access_token = data.access_token;
            if (data.refresh_token)
                creds.rawRoot.tokens.refresh_token = data.refresh_token;
            if (data.id_token)
                creds.rawRoot.tokens.id_token = data.id_token;
            creds.rawRoot.last_refresh = new Date().toISOString();
        }

        await this._writeCredentials(creds.filePath, creds.rawRoot);
        return data.access_token;
    }

    _storedToken() {
        if (!this._settings || !this._profileId)
            return null;
        const own = getToken(this._settings, this._profileId);
        if (own)
            return own;
        return this._allowSharedToken
            ? migrateLegacyToken(this._settings, this._profileId)
            : null;
    }

    async _refreshSettingsToken() {
        const stored = this._storedToken();
        if (!stored?.refreshToken)
            throw new UsageError('No usable Codex credentials; run `codex login`');
        const data = await this._exchangeRefreshToken(stored.refreshToken);
        setToken(this._settings, this._profileId, {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || stored.refreshToken,
            expiresAt: Date.now() + (data.expires_in ?? DEFAULT_EXPIRES_IN) * 1000,
        });
        return data.access_token;
    }

    async _settingsToken() {
        const stored = this._storedToken();
        if (!stored)
            throw new SignedOutError('No readable Codex credentials. Run `codex login` in your terminal.');
        if (stored.expiresAt && stored.expiresAt - Date.now() > REFRESH_SKEW_MS)
            return stored.accessToken;
        return this._refreshSettingsToken();
    }

    _validToken() {
        if (!this._tokenPromise) {
            this._tokenPromise = this._resolveToken()
                .finally(() => {
                    this._tokenPromise = null;
                });
        }
        return this._tokenPromise;
    }

    async _resolveToken() {
        const creds = await readCredentialsRoot(this._configDir);
        if (creds) {
            if (creds.accountId)
                this._lastAccountId = creds.accountId;
            const expiresAt = creds.expiresAt || 0;
            if (expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS)
                return creds.accessToken;
            if (creds.refreshToken) {
                try {
                    return await this._refreshFileToken(creds);
                } catch (e) {
                    if (this._storedToken())
                        return this._settingsToken();
                    throw e;
                }
            }
            if (creds.accessToken)
                return creds.accessToken;
        }

        return this._settingsToken();
    }

    async fetchUsage(cancellable = null) {
        const token = await this._validToken();
        return this._request('GET', USAGE_URL, {
            token,
            accountId: this._lastAccountId,
            cancellable,
        });
    }

    async fetchProfile(cancellable = null) {
        const token = await this._validToken();

        let me = null;
        let accounts = null;
        try {
            me = await this._request('GET', ME_URL, {token, cancellable});
        } catch {}

        if (this._lastAccountId) {
            try {
                accounts = await this._request('GET', ACCOUNTS_URL, {
                    token,
                    accountId: this._lastAccountId,
                    cancellable,
                });
            } catch {}
        }

        const claims = parseJwtClaims(token);
        const authClaims = claims?.['https://api.openai.com/auth'] || {};
        const profileClaims = claims?.['https://api.openai.com/profile'] || {};

        const email = me?.email || profileClaims.email || '';
        const name = me?.name || email;

        const activeAcc = accounts?.accounts?.[this._lastAccountId]?.account;
        const planType = activeAcc?.plan_type || authClaims.chatgpt_plan_type || 'free';
        const planDisplayName = activeAcc?.plan_display_name ||
            (planType.charAt(0).toUpperCase() + planType.slice(1));

        return {
            account: {
                email,
                name,
            },
            currentTier: {
                id: planType,
                name: planDisplayName,
            },
            paidTier: {
                id: planType,
                name: planDisplayName,
            },
            upgradeSubscriptionUri: SUBSCRIPTION_URL,
        };
    }

    async tierFromDisk() {
        const creds = await readCredentialsRoot(this._configDir);
        if (creds?.planType) {
            const pt = creds.planType;
            return {
                subscriptionType: pt.charAt(0).toUpperCase() + pt.slice(1),
                rateLimitTier: null,
            };
        }
        return {
            subscriptionType: 'ChatGPT',
            rateLimitTier: null,
        };
    }
}
