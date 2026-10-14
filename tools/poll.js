#!/usr/bin/env -S gjs -m
// Standalone check: validates the Codex usage client against the live API.
//   gjs -m tools/poll.js
import GLib from 'gi://GLib';
import {UsageClient, defaultConfigDir} from '../src/lib/usageClient.js';
import {normalizeWindows, normalizeSpend} from '../src/lib/usageModel.js';

const loop = GLib.MainLoop.new(null, false);

// GJS exposes extra script arguments as the global ARGV regardless of module
// mode. Accept an absolute path, a ~/-relative path, or a path relative to cwd.
function resolveConfigDir(arg) {
    if (!arg)
        return defaultConfigDir();
    if (arg.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), arg.slice(2)]);
    if (GLib.path_is_absolute(arg))
        return arg;
    return GLib.build_filenamev([GLib.get_current_dir(), arg]);
}

const configDir = resolveConfigDir(typeof ARGV !== 'undefined' ? ARGV[0] : undefined);

async function run() {
    const client = new UsageClient({configDir});

    print('config dir:', configDir);
    print('tier (from disk):', JSON.stringify(await client.tierFromDisk()));

    const profile = await client.fetchProfile();
    print('\nprofile:');
    print('  user email:', profile.account?.email);
    print('  user name:', profile.account?.name);
    print('  current tier:', profile.currentTier?.name, `(${profile.currentTier?.id})`);
    print('  paid tier:', profile.paidTier?.name ?? '(none)');
    print('  upgrade uri:', profile.upgradeSubscriptionUri);

    const usage = await client.fetchUsage();

    print('\nraw usage keys:', Object.keys(usage).join(', '));
    if (Array.isArray(usage.groups)) {
        print(`  groups[]: ${usage.groups.length} groups`);
        for (const g of usage.groups)
            print(`    - ${g.displayName}: ${(g.buckets || []).length} buckets`);
    }

    // Normalised windows — exactly what the extension renders.
    print('\nusage windows (normalised):');
    for (const w of normalizeWindows(usage)) {
        const active = w.isActive ? '  [active]' : '';
        const sev = w.apiLevel !== 'ok' ? `  api:${w.apiLevel}` : '';
        print(`  ${w.label}: ${w.utilization}%  resets ${w.resetsAt ?? '(n/a)'}${sev}${active}`);
    }

    const spend = normalizeSpend(usage);
    if (spend) {
        const pct = spend.percent !== null ? ` (${spend.percent}%)` : '';
        print(`\nextra usage: ${[spend.used, spend.limit].filter(Boolean).join(' / ')}${pct}  [${spend.level}]`);
    }
}

run()
    .catch(e => {
        printerr('ERROR:', e.message);
        if (e.body)
            printerr('BODY:', e.body);
        imports.system.exit(1);
    })
    .finally(() => loop.quit());

loop.run();
