// Profile list management: each profile is {id, label, configDir}, persisted
// as a JSON string in the "profiles" GSettings key (an array of small objects
// doesn't map cleanly onto a GVariant type, so JSON keeps this file and prefs
// simple). Kept free of `resource:///org/gnome/shell` imports so it stays
// usable from prefs and plain gjs, like usageClient.js.
import Gio from 'gi://Gio';
import {discoverConfigDirs, defaultConfigDir} from './usageClient.js';

export function loadProfiles(settings) {
    let list;
    try {
        list = JSON.parse(settings.get_string('profiles'));
    } catch {
        list = [];
    }
    return Array.isArray(list)
        ? list.filter(p => p && typeof p.configDir === 'string' && p.configDir)
        : [];
}

export function saveProfiles(settings, profiles) {
    settings.set_string('profiles', JSON.stringify(profiles));
}

// ".codex" -> "Codex", ".codex-work" -> "Work", ".codex-my-team" -> "My Team".
export function labelForDirName(name) {
    if (name === '.codex' || name === 'codex' || name === 'chatgpt' || name === 'ChatGPT')
        return 'Codex';
    const rest = name.replace(/^(\.codex-|\.chatgpt-|codex-|chatgpt-)/, '');
    const words = rest.split(/[-_]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1));
    return words.length > 0 ? words.join(' ') : 'Codex';
}

let seq = 0;
export function makeProfileId() {
    seq += 1;
    return `p${Date.now().toString(36)}${seq.toString(36)}`;
}

// Ensures at least one profile is configured, auto-detecting ~/.codex and any
// sibling ~/.codex-* directory that already holds Codex credentials. Runs once:
// once any profile is saved, later calls are a no-op, so a user who deletes down
// to zero profiles on purpose isn't re-seeded from under them by the next `enable()`.
export async function ensureProfiles(settings) {
    const existing = loadProfiles(settings);
    if (existing.length > 0)
        return existing;
    if (settings.get_boolean('profiles-initialized'))
        return existing;

    const discovered = await discoverConfigDirs();
    const seeded = discovered.length > 0
        ? discovered.map(({name, configDir}) => ({id: makeProfileId(), label: labelForDirName(name), configDir}))
        : [{id: makeProfileId(), label: 'Codex', configDir: defaultConfigDir()}];

    saveProfiles(settings, seeded);
    settings.set_boolean('profiles-initialized', true);
    // This is a one-time write that matters (it's what stops re-seeding from
    // running again on the next shell restart), so flush it immediately
    // rather than waiting for the periodic idle sync.
    Gio.Settings.sync();
    return seeded;
}
