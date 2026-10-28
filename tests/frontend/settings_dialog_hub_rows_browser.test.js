// Settings dialog on the hub (settings_dialog.js with cloud_settings.js, #8356: pinned before the file is split): the dialog keeps only the per-user rows, hides every machine row (working directory, CLI
// paths, remote access, API key, telemetry, privacy), says where the rest lives once, leaves the groups with no row out of the list and shows the first group that has one, and the payload filter keeps
// the hub's keys and drops the rest. The hub's own boot (mode cloud) is not available on the dev server, so the dialog is opened as the dashboard opens it and applyCloudSettingsDialog is run as
// showSettingsModal runs it on the hub. 1280 px, isolated dev server. Mutations of cloud_settings.js each fail it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { settle } = require('./helpers/wait');

const SHOWN = ['settings-theme', 'settings-renderer-select', 'settings-agent-type', 'settings-permission-mode', 'settings-show-summary', 'settings-group-by-team', 'settings-fit-pane-width', 'settings-notify-needs-input', 'settings-desktop-notify', 'settings-alert-needs-input', 'settings-alert-reply', 'settings-alert-sound', 'settings-file-search-limit'];
const MACHINE = ['settings-working-dir', 'settings-cli-path-claude', 'settings-remote-access-enabled', 'settings-api-key', 'settings-telemetry-enabled', 'settings-debug-input-log', 'settings-artifact-store-max', 'settings-terminal-font-size', 'settings-auto-resume'];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String(e.message).slice(0, 500)); } };
    const S = `(window.__coralStatic||'/static/')`;
    // a control's row is kept when the row (not its group's pane, which only shows while its group is open) is not hidden
    const visible = id => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return null; const row = e.closest('.settings-row, .sv-row, .tb-row'); return !(row && row.hidden); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const st = ${S}; window.SD = await import(st + 'settings_dialog.js'); window.CS = await import(st + 'cloud_settings.js'); await window.SD.showSettingsModal('general'); return true; })()`);
        await settle(ev, 800); // the rows the dialog loads on open (Security's, the terminal backend's) are in before the hub trims it, as they are when a person gets to the hub dialog
        await ev(`(() => { window.CS.applyCloudSettingsDialog(); window.CS.applyCloudSettingsDialog(); return true; })()`);

        await run('the per-user rows stay and the machine rows are hidden', async () => {
            const keep = {}, hide = {};
            for (const id of SHOWN) keep[id] = await visible(id);
            for (const id of MACHINE) hide[id] = await visible(id);
            assert.deepEqual(Object.entries(keep).filter(([, v]) => v === false).map(([k]) => k), [], 'a per-user row is hidden: ' + JSON.stringify(keep));
            assert.deepEqual(Object.entries(hide).filter(([, v]) => v === true).map(([k]) => k), [], 'a machine row is shown: ' + JSON.stringify(hide));
            assert.ok(SHOWN.some(id => keep[id] === true), 'some per-user row is on screen: ' + JSON.stringify(keep));
        });
        await run('the note says where machine settings live, once, even when applied twice', async () => {
            const notes = await ev(`[...document.querySelectorAll('#settings-modal .settings-cloud-note')].map(n => n.textContent)`);
            assert.equal(notes.length, 1, JSON.stringify(notes)); assert.match(notes[0], /saved on the hub/); assert.match(notes[0], /set on the machine in Coral/);
            assert.equal(await ev(`!!document.querySelector('#settings-modal .settings-panes > .settings-cloud-note')`), true, 'inside the content column');
        });
        await run('groups with no per-user row leave the list and the shown group has a row on screen', async () => {
            const tabs = await ev(`[...document.querySelectorAll('#settings-tabs [role=tab]')].map(t => [t.id.replace('settings-tab-', ''), t.hidden])`);
            // Security and privacy is not asserted: its password row is loaded by security_settings.js, which does not run on the hub, and here (not the hub) it is loaded and is not a hub row
            const left = tabs.filter(([, h]) => h).map(([g]) => g);
            assert.ok(left.includes('cleanup') && left.includes('network'), 'Storage and cleanup and Network and Hub have only machine rows and leave the list: ' + JSON.stringify(tabs));
            for (const g of ['general', 'agents', 'terminal', 'notifications', 'files']) assert.ok(!left.includes(g), `${g} keeps a per-user row and stays in the list: ${JSON.stringify(tabs)}`);
            assert.equal(await ev(`(() => { const p = [...document.querySelectorAll('#settings-modal .settings-pane')].find(x => !x.hidden); return !!p && !p.dataset.empty && !document.getElementById('settings-tab-' + p.dataset.group).hidden; })()`), true, 'the pane shown is a group that is in the list');
        });
        await run('the payload filter keeps the hub keys and drops the machine ones', async () => {
            const r = await ev(`(() => { const o = window.CS.filterSettingsPayload({ theme: 'dark', default_agent_type: 'codex', cli_path_claude: '/x', default_working_dir: '/y', remote_access_enabled: true, telemetry_enabled: false, git_diff_mode: 'x', file_search_limit: '10' }); return { kept: Object.keys(o.kept).sort(), dropped: o.dropped.sort() }; })()`);
            assert.deepEqual(r, { kept: ['default_agent_type', 'file_search_limit', 'git_diff_mode', 'theme'], dropped: ['cli_path_claude', 'default_working_dir', 'remote_access_enabled', 'telemetry_enabled'] }, JSON.stringify(r));
        });
    } finally { await client.close(); }
    const failed = results.filter(([, e]) => e);
    if (failed.length) { console.log(`\n${failed.length} of ${results.length} FAILED`); process.exit(1); }
    console.log(`PASS settings dialog hub rows: ${results.length} checks`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
