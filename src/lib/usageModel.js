// Pure data-shaping for the usage endpoint: turns the API payload into the
// ordered list of windows the popup renders, and normalises the spend / extra-
// usage money block. No GI or shell imports, so it runs under plain `node` and
// `gjs` and is unit-testable in isolation (see tools/poll.js and the tests).

const FIVE_HOUR_SECONDS = 5 * 3600;
const SEVEN_DAY_SECONDS = 7 * 24 * 3600;
export const GROUP_SECONDS = {session: FIVE_HOUR_SECONDS, weekly: SEVEN_DAY_SECONDS, '5h': FIVE_HOUR_SECONDS};

export function apiSeverityLevel(sev) {
    switch (sev) {
    case 'critical':
        return 'crit';
    case 'warning':
        return 'warn';
    default:
        return 'ok';
    }
}

function humanizeToken(s) {
    return String(s ?? '')
        .split(/[_\s]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

const KNOWN_MODEL = {
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o mini',
    'o1': 'o1',
    'o3': 'o3',
    'o3-mini': 'o3-mini',
};
export function modelLabel(name) {
    return KNOWN_MODEL[name] ?? humanizeToken(name);
}

const ROLE_ORDER = {session: 0, weekly: 1, scoped: 2, other: 3};

function windowSeconds(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function windowLabel(seconds, fallback) {
    if (seconds === null)
        return fallback;
    if (seconds % 86400 === 0)
        return `${seconds / 86400}-day`;
    if (seconds % 3600 === 0)
        return `${seconds / 3600}-hour`;
    if (seconds % 60 === 0)
        return `${seconds / 60}-minute`;
    return `${seconds}-second`;
}

function windowRole(seconds) {
    if (seconds === null)
        return 'other';
    return seconds >= 24 * 3600 ? 'weekly' : 'session';
}

function resetTime(seconds) {
    const timestamp = Number(seconds);
    if (!Number.isFinite(timestamp) || timestamp <= 0)
        return null;
    const date = new Date(timestamp * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rateWindow(win, key, fallbackLabel) {
    const seconds = windowSeconds(win.limit_window_seconds);
    const utilization = win.used_percent == null ? NaN : Number(win.used_percent);
    if (!Number.isFinite(utilization))
        return null;
    const util = Math.max(0, Math.min(100, Math.round(utilization * 10) / 10));
    const role = windowRole(seconds);
    return {
        key,
        label: windowLabel(seconds, fallbackLabel),
        role,
        utilization: util,
        resetsAt: resetTime(win.reset_at),
        totalSeconds: seconds,
        apiLevel: util >= 90 ? 'crit' : util >= 75 ? 'warn' : 'ok',
        isActive: util > 0,
        order: ROLE_ORDER[role],
    };
}

// The ordered list of windows to display. Prefers the Codex rate_limit
// windows; falls back to limits[] or legacy flat keys for compatibility.
// Entries without a numeric utilization are dropped.
export function normalizeWindows(usage) {
    if (usage?.rate_limit) {
        const out = [];
        const rl = usage.rate_limit;

        if (rl.primary_window) {
            const window = rateWindow(rl.primary_window, 'chatgpt:primary_5h', 'Primary limit');
            if (window)
                out.push(window);
        }

        if (rl.secondary_window) {
            const window = rateWindow(rl.secondary_window, 'chatgpt:secondary_7d', 'Secondary limit');
            if (window)
                out.push(window);
        }

        if (usage.model_usage && typeof usage.model_usage === 'object') {
            for (const [model, info] of Object.entries(usage.model_usage)) {
                if (info && info.available === false && info.available_at) {
                    const resetsAt = resetTime(info.available_at);
                    out.push({
                        key: `chatgpt:model:${model}`,
                        label: `${modelLabel(model)}`,
                        role: 'scoped',
                        utilization: 100,
                        resetsAt,
                        totalSeconds: null,
                        apiLevel: 'crit',
                        isActive: true,
                        order: ROLE_ORDER.scoped,
                    });
                }
            }
        }

        if (out.length) {
            out.sort((a, b) => a.order - b.order);
            return out;
        }
    }

    if (Array.isArray(usage?.limits) && usage.limits.length) {
        const out = usage.limits
            .filter(l => l && l.percent != null && Number.isFinite(Number(l.percent)))
            .map(l => ({
                key: `limit:${l.kind || 'limit'}`,
                label: l.kind === 'session' ? '5-hour' : '7-day',
                role: l.kind === 'session' ? 'session' : 'weekly',
                utilization: Number(l.percent),
                resetsAt: l.resets_at ?? null,
                totalSeconds: l.kind === 'session' ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS,
                apiLevel: apiSeverityLevel(l.severity),
                isActive: !!l.is_active,
                order: l.kind === 'session' ? 0 : 1,
            }));
        if (out.length) {
            out.sort((a, b) => a.order - b.order);
            return out;
        }
    }

    const out = [];
    if (usage?.five_hour) {
        out.push({
            key: 'legacy:five_hour',
            label: '5-hour',
            role: 'session',
            utilization: Number(usage.five_hour.utilization || 0),
            resetsAt: usage.five_hour.resets_at ?? null,
            totalSeconds: FIVE_HOUR_SECONDS,
            apiLevel: 'ok',
            isActive: false,
            order: 0,
        });
    }
    if (usage?.seven_day) {
        out.push({
            key: 'legacy:seven_day',
            label: '7-day',
            role: 'weekly',
            utilization: Number(usage.seven_day.utilization || 0),
            resetsAt: usage.seven_day.resets_at ?? null,
            totalSeconds: SEVEN_DAY_SECONDS,
            apiLevel: 'ok',
            isActive: false,
            order: 1,
        });
    }
    return out;
}

export function normalizeSpend(usage) {
    if (usage?.rate_limit_reset_credits?.available_count > 0) {
        const count = usage.rate_limit_reset_credits.available_count;
        return {
            used: `${count} reset credit${count > 1 ? 's' : ''}`,
            limit: null,
            percent: null,
            level: 'ok',
        };
    }
    if (usage?.spend) {
        return {
            used: usage.spend.used ?? null,
            limit: usage.spend.limit ?? null,
            percent: usage.spend.percent ?? null,
            level: 'ok',
        };
    }
    return null;
}

export const PANEL_SELECTORS = ['five-hour', 'seven-day', 'scoped', 'max', 'worst'];

export function migratePanelWindows(settings) {
    if (settings.get_user_value('panel-windows') !== null)
        return;
    if (settings.get_user_value('panel-window') === null)
        return;
    const old = settings.get_string('panel-window');
    if (PANEL_SELECTORS.includes(old))
        settings.set_strv('panel-windows', [old]);
}

export function selectPanelWindows(windows, selectors, worstScore = w => Number(w.utilization) || 0) {
    if (!Array.isArray(windows) || !windows.length)
        return [];
    const picked = new Set();
    const highest = pool => pool.reduce((best, w) =>
        (Number(w.utilization) || 0) > (Number(best.utilization) || 0) ? w : best);
    for (const sel of selectors ?? []) {
        switch (sel) {
        case 'five-hour': {
            const w = windows.find(x => x.role === 'session');
            if (w)
                picked.add(w.key);
            break;
        }
        case 'seven-day': {
            const w = windows.find(x => x.role === 'weekly');
            if (w)
                picked.add(w.key);
            break;
        }
        case 'scoped':
            for (const w of windows) {
                if (w.role === 'scoped')
                    picked.add(w.key);
            }
            break;
        case 'max':
            picked.add(highest(windows).key);
            break;
        case 'worst': {
            const active = windows.filter(w => w.isActive);
            const pool = active.length ? active : windows;
            const w = pool.reduce((best, x) => (worstScore(x) > worstScore(best) ? x : best));
            picked.add(w.key);
            break;
        }
        default:
            break;
        }
    }
    const out = windows.filter(w => picked.has(w.key));
    return out.length ? out : [windows[0]];
}

const RESET_MERGE_MS = 5 * 60 * 1000;
const isWeekly = w => w?.role === 'weekly' || w?.role === 'scoped';

function resetMs(iso) {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? null : t;
}

export function groupPanelWindows(windows) {
    const groups = [];
    const weekly = [];
    for (const w of windows ?? []) {
        const ms = resetMs(w.resetsAt);
        if (isWeekly(w)) {
            const home = ms === null
                ? weekly.at(-1)
                : weekly.find(g => g.ms === null || Math.abs(g.ms - ms) <= RESET_MERGE_MS);
            if (home) {
                home.group.windows.push(w);
                if (home.ms === null && ms !== null) {
                    home.ms = ms;
                    home.group.resetsAt = w.resetsAt;
                }
                continue;
            }
        }
        const group = {windows: [w], resetsAt: ms === null ? null : w.resetsAt};
        groups.push(group);
        if (isWeekly(w))
            weekly.push({group, ms});
    }
    return groups;
}

export function windowTag(w) {
    switch (w?.role) {
    case 'session':
    case 'weekly':
        if (w.totalSeconds)
            return windowLabel(w.totalSeconds, '').replace(/-hour$/, 'h').replace(/-day$/, 'd').replace(/-minute$/, 'm');
        return w.label ?? '';
    case 'scoped':
        return w?.label?.replace(/^7-day\s*/, '') ?? '';
    default:
        return w?.label ?? '';
    }
}

export const TIER_ICONS = ['free', 'plus', 'pro', 'ultra', 'max', 'team', 'enterprise'];

export function tierIconName(label) {
    const slug = String(label ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    return [slug, slug.split('-')[0]].find(name => TIER_ICONS.includes(name)) ?? null;
}
