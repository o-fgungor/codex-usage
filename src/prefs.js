import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {codexCredentialsAvailable} from './lib/usageClient.js';
import {loadProfiles, saveProfiles, makeProfileId, labelForDirName, ensureProfiles} from './lib/profiles.js';
import {getToken, clearToken} from './lib/tokenStore.js';
import {PANEL_SELECTORS, migratePanelWindows} from './lib/usageModel.js';
import {UI_PAGES} from './lib/uiStyle.js';
import {buildUiStylePage} from './lib/uiStylePage.js';

// Keys that type nothing, so binding them without a modifier steals no input:
// the function keys (F1-F35, contiguous) and the XF86 media/extra keys, which
// all sit above 0x1008FF00.
const XF86_KEY_BASE = 0x1008ff00;
function isDedicatedKey(keyval) {
    return (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) || keyval >= XF86_KEY_BASE;
}

// Gtk.FileDialog predates GJS's automatic async/finish pairing for this
// class on some GNOME versions, so promisify it explicitly.
Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

// Opens a native folder picker rooted at initialPath; returns the chosen path,
// or null if the user cancelled (or the dialog failed for any reason - not
// worth surfacing, the user can just try again).
async function pickFolder(window, initialPath) {
    const dialog = new Gtk.FileDialog({title: 'Select a Codex config folder'});
    if (initialPath) {
        try {
            dialog.set_initial_folder(Gio.File.new_for_path(initialPath));
        } catch {
            // Best-effort; the dialog falls back to its own default location.
        }
    }
    try {
        const folder = await dialog.select_folder(window, null);
        return folder.get_path();
    } catch {
        return null;
    }
}

export default class CodexUsagePreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Carry a pre-1.5 single "panel reflects" choice into panel-windows
        // before the switches below read it (the extension does the same, but
        // prefs can open first).
        migratePanelWindows(settings);

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);
        // The other tabs: the sizes, spacing and colors of the top bar and
        // of the popup, and before those what the two have in common.
        for (const {id} of UI_PAGES)
            window.add(buildUiStylePage(settings, window, id).page);

        // ---- which elements appear in the panel ----
        const elements = new Adw.PreferencesGroup({
            title: 'Panel elements',
            description: 'Choose what to show in the top bar.',
        });
        page.add(elements);

        const toggles = [
            ['show-icon', 'Codex icon'],
            ['show-percentage', 'Usage percentage'],
            ['show-tier', 'Subscription tier label'],
            ['show-tier-icon', 'Subscription tier icon'],
        ];
        for (const [key, title] of toggles) {
            const row = new Adw.SwitchRow({title});
            elements.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        // Only has any effect with more than one profile configured.
        const chipRow = new Adw.SwitchRow({
            title: 'Profile tag',
            subtitle: 'Show a short tag (e.g. "DW") before each profile\'s gauge, when you have more than one profile.',
        });
        elements.add(chipRow);
        settings.bind('show-profile-chip', chipRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Time-until-reset for each window chosen under "Panel reflects" below.
        const resetRow = new Adw.SwitchRow({
            title: 'Time until reset',
            subtitle: 'Show the time left before each window shown in the panel resets (once for the 7-day windows, which reset together).',
        });
        elements.add(resetRow);
        settings.bind('show-reset', resetRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const gauges = new Gtk.StringList();
        gauges.append('Circle');
        gauges.append('Bar');
        gauges.append('None');
        const gaugeKeys = ['ring', 'bar', 'none'];

        const gaugeRow = new Adw.ComboRow({
            title: 'Usage gauge',
            subtitle: 'Show a circular ring, a horizontal bar, or no gauge.',
            model: gauges,
        });
        gaugeRow.selected = Math.max(0, gaugeKeys.indexOf(settings.get_string('panel-gauge')));
        gaugeRow.connect('notify::selected', () => {
            settings.set_string('panel-gauge', gaugeKeys[gaugeRow.selected]);
        });
        settings.connect('changed::panel-gauge', () => {
            gaugeRow.selected = Math.max(0, gaugeKeys.indexOf(settings.get_string('panel-gauge')));
        });
        elements.add(gaugeRow);

        // ---- which usage windows the panel shows ----
        // (What divides them, the two divider texts, is under "Top-Bar UI".)
        this._addPanelWindowsGroup(page, settings);

        // ---- behaviour ----
        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);

        const positions = new Gtk.StringList();
        positions.append('Left');
        positions.append('Center');
        positions.append('Right');
        const positionKeys = ['left', 'center', 'right'];

        const positionRow = new Adw.ComboRow({
            title: 'Panel position',
            subtitle: 'Which section of the top bar the indicator sits in.',
            model: positions,
        });
        positionRow.selected = Math.max(0, positionKeys.indexOf(settings.get_string('panel-position')));
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positionKeys[positionRow.selected]);
        });
        settings.connect('changed::panel-position', () => {
            positionRow.selected = Math.max(0, positionKeys.indexOf(settings.get_string('panel-position')));
        });
        behaviour.add(positionRow);

        const indexRow = new Adw.SpinRow({
            title: 'Position in that section',
            subtitle: 'Raise this to move the indicator further along; 0 puts it first.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1, page_increment: 5}),
        });
        behaviour.add(indexRow);
        settings.bind('panel-index', indexRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        behaviour.add(this._buildShortcutRow(settings, window));

        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between usage updates.',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
            }),
        });
        behaviour.add(interval);
        settings.bind('poll-seconds', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ---- profiles (one per Codex account / config directory) ----
        await this._addProfilesGroup(page, settings, window);

        // Each profile row reports the CLI credentials it can read and lets
        // users remove any token saved by an older extension version.
        this._addAboutGroup(page);
    }

    // Adds the "Panel reflects" group: one switch per selector in the
    // panel-windows list (any combination; the panel shows one gauge per
    // matched window, tagged when there is more than one). The switches and
    // the setting are kept in sync both ways, like the combo rows above; GTK
    // does not re-notify an unchanged `active`, so the round trip settles.
    _addPanelWindowsGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Panel reflects',
            description: 'Which usage windows the top bar shows. Turn on more than one ' +
                'to show them side by side, each with a short tag based on the reported period. ' +
                'Only windows reported for this account can appear. With none selected, the panel shows the first available window; to show ' +
                'no gauge at all, set the gauge to "None" and turn off the usage percentage.',
        });
        page.add(group);

        const rows = [
            ['five-hour', 'Short window', 'A reported Codex window shorter than one day, when available.'],
            ['seven-day', 'Long window', 'A reported Codex window of one day or longer, when available.'],
            ['scoped', 'Model limits', 'Additional model limits reported by Codex, when available.'],
            ['max', 'Most constrained', 'Whichever window has the highest usage.'],
            ['worst', 'Worst active limit', 'Highest severity among the active limits; surfaces a maxed-out per-model window.'],
        ];
        const switches = new Map();
        const selected = () => new Set(settings.get_strv('panel-windows'));
        let syncing = false;
        for (const [key, title, subtitle] of rows) {
            const row = new Adw.SwitchRow({title, subtitle});
            row.active = selected().has(key);
            row.connect('notify::active', () => {
                if (syncing)
                    return;
                const on = PANEL_SELECTORS.filter(k => switches.get(k)?.active);
                settings.set_strv('panel-windows', on);
            });
            switches.set(key, row);
            group.add(row);
        }
        settings.connect('changed::panel-windows', () => {
            const on = selected();
            syncing = true;
            for (const [key, row] of switches)
                row.active = on.has(key);
            syncing = false;
        });
    }

    // Adds a "Codex profiles" group: one expandable row per configured
    // profile (name, config folder, its own sign-in, and — only when another
    // profile would remain — remove), plus an "Add profile" row. Each
    // profile is just a Codex config directory (such as ~/.codex); the extension
    // shows every configured profile side by side and refreshes them together.
    async _addProfilesGroup(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Codex profiles',
            description: 'One row per Codex profile. A profile is a config ' +
                'directory such as ~/.codex. Add one for each ' +
                'account you want visible - and refreshed - at the same time.',
        });
        page.add(group);

        let rows = [];
        const rerender = () => {
            for (const row of rows)
                group.remove(row);
            // Profile rows first, "Add profile" always last. Removal is only
            // offered when another profile would remain: with a single profile
            // there is nothing to fall back to, and deleting it by accident
            // leaves an empty panel that is fiddly to recover from.
            const profiles = loadProfiles(settings);
            rows = profiles.map(p => buildProfileRow(p, profiles.length > 1));
            rows.push(buildAddRow());
        };

        const persist = profiles => {
            saveProfiles(settings, profiles);
            rerender();
        };

        const buildProfileRow = (profile, canRemove) => {
            const row = new Adw.ExpanderRow({title: profile.label, subtitle: profile.configDir});
            group.add(row);

            const nameRow = new Adw.EntryRow({title: 'Name', text: profile.label, show_apply_button: true});
            nameRow.connect('apply', () => {
                const profiles = loadProfiles(settings);
                const p = profiles.find(x => x.id === profile.id);
                if (p) {
                    p.label = nameRow.get_text().trim() || p.label;
                    persist(profiles);
                }
            });
            row.add_row(nameRow);

            const folderRow = new Adw.ActionRow({title: 'Config folder', subtitle: profile.configDir});
            const changeBtn = new Gtk.Button({label: 'Change…', valign: Gtk.Align.CENTER});
            changeBtn.connect('clicked', async () => {
                const dir = await pickFolder(window, profile.configDir);
                if (!dir)
                    return;
                const profiles = loadProfiles(settings);
                const p = profiles.find(x => x.id === profile.id);
                if (p) {
                    p.configDir = dir;
                    persist(profiles);
                }
            });
            folderRow.add_suffix(changeBtn);
            row.add_row(folderRow);

            this._addSignInRows(row, settings, profile);

            if (!canRemove)
                return row;

            const removeRow = new Adw.ActionRow({title: 'Remove this profile'});
            const removeBtn = new Gtk.Button({
                label: 'Remove', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
            });
            removeBtn.connect('clicked', () => {
                // Drop the profile's stored sign-in too, so a removed account's
                // tokens don't linger in settings.
                clearToken(settings, profile.id);
                Gio.Settings.sync();
                persist(loadProfiles(settings).filter(x => x.id !== profile.id));
            });
            removeRow.add_suffix(removeBtn);
            row.add_row(removeRow);

            return row;
        };

        const buildAddRow = () => {
            const row = new Adw.ActionRow({
                title: 'Add profile',
                subtitle: 'Point at another Codex config directory',
            });
            const addBtn = new Gtk.Button({
                label: 'Add…', valign: Gtk.Align.CENTER, css_classes: ['suggested-action'],
            });
            addBtn.connect('clicked', async () => {
                const dir = await pickFolder(window, GLib.get_home_dir());
                if (!dir)
                    return;
                const profiles = loadProfiles(settings);
                if (profiles.some(p => p.configDir === dir))
                    return;
                profiles.push({
                    id: makeProfileId(),
                    label: labelForDirName(GLib.path_get_basename(dir)),
                    configDir: dir,
                });
                persist(profiles);
            });
            row.add_suffix(addBtn);
            group.add(row);
            return row;
        };

        await ensureProfiles(settings);
        rerender();
    }

    // Adds a centered footer crediting the author, linking to the project for
    // bug reports and feature requests, and showing the version.
    // A row showing the current shortcut for opening the popup, which opens a
    // small capture dialog when activated. The key is an "as" array, matching
    // how the shell stores its own keybindings.
    _buildShortcutRow(settings, window) {
        const row = new Adw.ActionRow({
            title: 'Shortcut to open the popup',
            subtitle: 'Opens and closes the usage dropdown without the mouse. Needs a modifier, unless it is a function or media key. Not set by default.',
            activatable: true,
        });

        const label = new Gtk.ShortcutLabel({
            disabled_text: 'Not set',
            valign: Gtk.Align.CENTER,
        });
        const syncLabel = () => {
            label.set_accelerator(settings.get_strv('toggle-menu')[0] ?? '');
        };
        syncLabel();
        settings.connect('changed::toggle-menu', syncLabel);
        row.add_suffix(label);

        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Clear the shortcut',
        });
        clear.connect('clicked', () => settings.set_strv('toggle-menu', []));
        row.add_suffix(clear);

        row.connect('activated', () => this._captureShortcut(settings, window));
        return row;
    }

    // Modal that grabs the next key combination. Escape cancels, Backspace
    // clears, and a bare key without modifiers is ignored — otherwise typing a
    // letter would steal it system-wide.
    _captureShortcut(settings, window) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            default_width: 380,
            default_height: 180,
            title: 'Set shortcut',
        });

        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false}));
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            spacing: 8,
            margin_start: 24, margin_end: 24, margin_top: 12, margin_bottom: 24,
        });
        box.append(new Gtk.Label({
            label: 'Press the key combination you want to use.',
            wrap: true,
        }));
        box.append(new Gtk.Label({
            label: 'Esc to cancel, Backspace to clear.',
            wrap: true,
            css_classes: ['dim-label'],
        }));
        view.set_content(box);
        dialog.set_content(view);

        const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape && !mask) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && !mask) {
                settings.set_strv('toggle-menu', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Gtk.accelerator_valid() accepts a bare letter, so it cannot be
            // relied on alone: binding one would swallow ordinary typing
            // system-wide. Require a modifier, except for keys that produce no
            // text at all — the function keys and the XF86 media/extra keys are
            // safe on their own, and are exactly what a keyboard with more than
            // twelve F-keys is for.
            if ((!mask && !isDedicatedKey(keyval)) || !Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            settings.set_strv('toggle-menu', [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present();
    }

    _addAboutGroup(page) {
        const footer = new Adw.PreferencesGroup();
        page.add(footer);

        const url = this.metadata.url ?? 'https://github.com/o-fgungor/codex-usage';
        const issuesUrl = `${url}/issues/new`;

        const buttons = new Gtk.Box({
            spacing: 8,
            margin_bottom: 16,
            halign: Gtk.Align.CENTER,
        });
        buttons.append(this._buildLinkButton('Report a bug', issuesUrl));
        buttons.append(this._buildLinkButton('Request a feature', issuesUrl));
        footer.add(buttons);

        footer.add(new Gtk.Label({
            label: 'Have an issue, want to suggest a feature, or contribute?',
            margin_bottom: 4,
        }));
        footer.add(new Gtk.Label({
            label: `Open a new issue on <a href="${url}">GitHub</a>!`,
            use_markup: true,
            margin_bottom: 24,
        }));

        footer.add(new Gtk.Label({
            label: 'Created by <b>Ömer Faruk Güngör</b>\n' +
                'Based on <b>ClaudeCodeUsage</b> by <b>Dennis van der Stelt and contributors</b>',
            use_markup: true,
            halign: Gtk.Align.CENTER,
            justify: Gtk.Justification.CENTER,
            margin_bottom: 4,
        }));

        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        if (version) {
            footer.add(new Gtk.Label({
                label: `· Codex Usage Monitor v${version} ·`,
                css_classes: ['dim-label'],
            }));
        }
    }

    // A plain button that opens a URL in the default browser.
    _buildLinkButton(label, uri) {
        const btn = new Gtk.Button({label, hexpand: false});
        btn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        });
        return btn;
    }

    // The provider CLI owns new sign-in. Keep old in-app tokens usable and
    // removable for users who connected with an earlier extension version.
    _addSignInRows(expander, settings, profile) {
        const statusRow = new Adw.ActionRow({title: 'Sign-in status'});
        const statusLabel = new Gtk.Label({valign: Gtk.Align.CENTER});
        statusRow.add_suffix(statusLabel);
        expander.add_row(statusRow);

        const setStatus = (message, connected) => {
            statusLabel.set_label(message);
            statusLabel.set_css_classes(connected ? ['success'] : ['dim-label']);
        };

        const instructionRow = new Adw.ActionRow({
            title: 'Sign in with Codex CLI',
            subtitle: 'Run codex login in a terminal and complete sign-in.',
        });
        expander.add_row(instructionRow);

        const hasLegacyToken = getToken(settings, profile.id) !== null;
        if (hasLegacyToken) {
            const forgetRow = new Adw.ActionRow({
                title: 'Older extension sign-in',
                subtitle: 'Forget the token saved by an earlier extension version.',
            });
            const forgetButton = new Gtk.Button({
                label: 'Forget', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'],
            });
            forgetRow.add_suffix(forgetButton);
            forgetRow.set_activatable_widget(forgetButton);
            expander.add_row(forgetRow);
            forgetButton.connect('clicked', () => {
                clearToken(settings, profile.id);
                Gio.Settings.sync();
                forgetRow.set_visible(false);
                refreshStatus();
            });
        }

        const refreshStatus = async () => {
            if (await codexCredentialsAvailable(profile.configDir))
                setStatus('Codex CLI credential file found', true);
            else if (getToken(settings, profile.id))
                setStatus('Older extension token found', true);
            else
                setStatus('No readable credentials', false);
        };
        refreshStatus();
    }
}
