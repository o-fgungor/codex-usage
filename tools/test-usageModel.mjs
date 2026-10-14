#!/usr/bin/env node
// Unit tests for the pure Codex usage model. Runs under plain node (no GI):
//   node tools/test-usageModel.mjs
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {
    normalizeWindows, normalizeSpend, apiSeverityLevel, modelLabel,
    selectPanelWindows, windowTag, migratePanelWindows, groupPanelWindows, tierIconName,
    PANEL_SELECTORS, TIER_ICONS,
} from '../src/lib/usageModel.js';

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
};

// --- severity mapping ---
test('apiSeverityLevel maps critical/warning/normal + falls back to ok', () => {
    assert.equal(apiSeverityLevel('critical'), 'crit');
    assert.equal(apiSeverityLevel('warning'), 'warn');
    assert.equal(apiSeverityLevel('normal'), 'ok');
    assert.equal(apiSeverityLevel('something-new'), 'ok');
    assert.equal(apiSeverityLevel(undefined), 'ok');
});

// --- model labels ---
test('modelLabel formats known models and humanizes unknown ones', () => {
    assert.equal(modelLabel('gpt-4o'), 'GPT-4o');
    assert.equal(modelLabel('gpt-4o-mini'), 'GPT-4o mini');
    assert.equal(modelLabel('o1'), 'o1');
    assert.equal(modelLabel('o3-mini'), 'o3-mini');
    assert.equal(modelLabel('custom_preview_model'), 'Custom Preview Model');
});

// --- real ChatGPT codex/usage payload ---
const chatgptLive = {
    plan_type: 'team',
    rate_limit: {
        primary_window: {
            used_percent: 18.2,
            limit_window_seconds: 18000,
            reset_at: 1791773362,
        },
        secondary_window: {
            used_percent: 85.0,
            limit_window_seconds: 604800,
            reset_at: 1792360162,
        },
    },
    rate_limit_reset_credits: {
        available_count: 3,
    },
};

test('normalizeWindows parses primary and secondary rate limit windows', () => {
    const ws = normalizeWindows(chatgptLive);
    assert.equal(ws.length, 2, 'two windows');
    assert.deepEqual(ws.map(w => w.role), ['session', 'weekly']);
    assert.deepEqual(ws.map(w => w.label), ['5-hour', '7-day']);

    const primary = ws[0];
    assert.equal(primary.key, 'chatgpt:primary_5h');
    assert.equal(primary.utilization, 18.2);
    assert.equal(primary.apiLevel, 'ok');
    assert.equal(primary.isActive, true);
    assert.equal(primary.totalSeconds, 18000);
    assert.equal(primary.resetsAt, new Date(1791773362 * 1000).toISOString());

    const secondary = ws[1];
    assert.equal(secondary.key, 'chatgpt:secondary_7d');
    assert.equal(secondary.utilization, 85);
    assert.equal(secondary.apiLevel, 'warn');
    assert.equal(secondary.isActive, true);
    assert.equal(secondary.totalSeconds, 604800);
    assert.equal(secondary.resetsAt, new Date(1792360162 * 1000).toISOString());
});

test('Codex uses reported durations and does not invent a missing five-hour window', () => {
    const weeklyOnly = normalizeWindows({rate_limit: {
        primary_window: {used_percent: 42, limit_window_seconds: 604800, reset_at: 1792360162},
    }});
    assert.equal(weeklyOnly.length, 1);
    assert.equal(weeklyOnly[0].label, '7-day');
    assert.equal(weeklyOnly[0].role, 'weekly');
    assert.equal(windowTag(weeklyOnly[0]), '7d');
    assert.deepEqual(selectPanelWindows(weeklyOnly, ['five-hour']), weeklyOnly);

    const alternate = normalizeWindows({rate_limit: {
        primary_window: {used_percent: 20, limit_window_seconds: 10800},
        secondary_window: {used_percent: 30, limit_window_seconds: 1209600},
    }});
    assert.deepEqual(alternate.map(w => w.label), ['3-hour', '14-day']);
    assert.deepEqual(alternate.map(windowTag), ['3h', '14d']);

    const unknown = normalizeWindows({rate_limit: {
        primary_window: {used_percent: 12},
    }});
    assert.equal(unknown[0].label, 'Primary limit');
    assert.equal(unknown[0].totalSeconds, null);
});

test('normalizeWindows surfaces rate-limited model_usage as scoped window', () => {
    const payload = {
        rate_limit: {
            primary_window: {used_percent: 10, limit_window_seconds: 18000, reset_at: 1791773362},
            secondary_window: {used_percent: 20, limit_window_seconds: 604800, reset_at: 1792360162},
        },
        model_usage: {
            'o1': {available: false, available_at: 1791773362},
            'gpt-4o': {available: true},
        },
    };
    const ws = normalizeWindows(payload);
    assert.equal(ws.length, 3);
    assert.deepEqual(ws.map(w => w.role), ['session', 'weekly', 'scoped']);
    assert.equal(ws[2].label, 'o1');
    assert.equal(ws[2].utilization, 100);
    assert.equal(ws[2].apiLevel, 'crit');
    assert.equal(ws[2].isActive, true);
});

test('empty/garbage usage yields no windows without throwing', () => {
    assert.deepEqual(normalizeWindows(null), []);
    assert.deepEqual(normalizeWindows({}), []);
});

// --- spend / reset credits ---
test('normalizeSpend surfaces reset credits when available', () => {
    const s = normalizeSpend(chatgptLive);
    assert.equal(s.used, '3 reset credits');
    assert.equal(s.limit, null);
    assert.equal(s.level, 'ok');
});

test('normalizeSpend handles single reset credit singular', () => {
    const s = normalizeSpend({rate_limit_reset_credits: {available_count: 1}});
    assert.equal(s.used, '1 reset credit');
});

test('normalizeSpend returns null when no credits or spend info', () => {
    assert.equal(normalizeSpend({}), null);
    assert.equal(normalizeSpend(null), null);
});

// --- panel window selection ---
const liveWindows = normalizeWindows(chatgptLive);
const keys = ws => ws.map(w => w.key);
const SESSION = 'chatgpt:primary_5h';
const WEEKLY = 'chatgpt:secondary_7d';

test('selectPanelWindows: each selector alone picks expected window', () => {
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['five-hour'])), [SESSION]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['seven-day'])), [WEEKLY]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['max'])), [WEEKLY]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['worst'])), [WEEKLY]);
});

test('selectPanelWindows: union keeps role order and drops duplicates', () => {
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['seven-day', 'five-hour'])), [SESSION, WEEKLY]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, PANEL_SELECTORS)), [SESSION, WEEKLY]);
});

test('windowTag: short tags for panel', () => {
    assert.deepEqual(liveWindows.map(windowTag), ['5h', '7d']);
    assert.equal(windowTag({role: 'scoped', label: '7-day o1'}), 'o1');
});

test('groupPanelWindows: windows grouping and reset merge', () => {
    const groups = groupPanelWindows(liveWindows);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].windows[0].key, SESSION);
    assert.equal(groups[0].resetsAt, new Date(1791773362 * 1000).toISOString());
    assert.equal(groups[1].windows[0].key, WEEKLY);
    assert.equal(groups[1].resetsAt, new Date(1792360162 * 1000).toISOString());
});

test('groupPanelWindows: weekly + scoped with same reset merge into one group', () => {
    const iso = '2026-10-18T21:00:00Z';
    const windows = [
        {key: 's', role: 'session', resetsAt: '2026-10-12T02:00:00Z'},
        {key: 'w', role: 'weekly', resetsAt: iso},
        {key: 'm', role: 'scoped', resetsAt: iso},
    ];
    const groups = groupPanelWindows(windows);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[1].windows.map(w => w.key), ['w', 'm']);
    assert.equal(groups[1].resetsAt, iso);
});

// --- tier icons ---
test('tierIconName: recognizes plus, pro, team, enterprise, free', () => {
    assert.equal(tierIconName('PLUS'), 'plus');
    assert.equal(tierIconName('PRO'), 'pro');
    assert.equal(tierIconName('TEAM'), 'team');
    assert.equal(tierIconName('ENTERPRISE'), 'enterprise');
    assert.equal(tierIconName('FREE'), 'free');
    assert.equal(tierIconName('CHATGPT'), null);
    assert.equal(tierIconName(''), null);
    assert.equal(tierIconName(null), null);
});

test('TIER_ICONS: every listed tier has its artwork in src/icons', () => {
    for (const name of TIER_ICONS) {
        const file = new URL(`../src/icons/tier-${name}-symbolic.svg`, import.meta.url);
        assert.ok(existsSync(file), `missing ${file.pathname}`);
    }
});

test('migratePanelWindows: seeds the list from the old single choice', () => {
    const fake = (user) => {
        const writes = [];
        return {
            writes,
            get_user_value: k => (k in user ? user[k] : null),
            get_string: k => user[k],
            set_strv: (k, v) => writes.push([k, v]),
        };
    };
    let s = fake({'panel-window': 'seven-day'});
    migratePanelWindows(s);
    assert.deepEqual(s.writes, [['panel-windows', ['seven-day']]]);
});

console.log(`\n${passed} tests passed`);
