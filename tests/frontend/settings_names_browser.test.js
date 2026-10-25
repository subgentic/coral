// Settings names and heading order (#7282, UI Accessibility's #7281): the two "What to prune" selects and their number fields are told apart by their section, the Default thinking select says which CLI, the Terminal
// backend choices are named "tmux" and "pty" (the sentence describes them) inside a radiogroup, a password field's name is its label (the Show button is beside the label, not inside it), Network and Hub's headings go
// h4, then h5 sections with h6 under them (no jumping up and down), and the CLI paths disclosure has one marker. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const open = async (group) => {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        await ev(`(async () => { await window.showSettingsModal(${JSON.stringify(group)}); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings', 10000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        console.log('1. Storage and cleanup: the two selects and number fields have different names');
        await open('storage');
        const names = await ev(`['settings-prune-kind', 'settings-retention-kind', 'settings-prune-days', 'settings-retention-days'].map(id => document.getElementById(id).getAttribute('aria-label'))`);
        assert.deepEqual(names, ['What to prune, free space', 'What to prune, automatic cleanup', 'Older than, in days, free space', 'Older than, in days, automatic cleanup']);
        console.log('2. Agents: Default thinking says which CLI');
        await open('agents');
        assert.equal(await ev(`document.getElementById('settings-default-thinking-claude').getAttribute('aria-label')`), 'Claude default thinking');
        console.log('3. Terminal: the backend choices are named tmux and pty, in a radiogroup');
        await open('terminal');
        const tb = await ev(`(() => { const n = id => { const e = document.getElementById(id); return e ? e.getAttribute('aria-label') : null; }; const d = id => { const e = document.getElementById(id); const ref = e && document.getElementById(e.getAttribute('aria-describedby')); return ref ? ref.textContent.slice(0, 8) : null; }; return { role: document.getElementById('settings-terminal-backend').getAttribute('role'), tmux: n('tb-opt-tmux'), pty: n('tb-opt-pty'), tmuxDesc: d('tb-opt-tmux'), ptyDesc: d('tb-opt-pty') }; })()`);
        assert.deepEqual(tb, { role: 'radiogroup', tmux: 'tmux', pty: 'pty', tmuxDesc: 'tmux: ag', ptyDesc: 'pty: age' });
        console.log('4. Network and Hub: headings h4, then h5 sections, h6 below; no jumps');
        await open('network');
        const levels = await ev(`[...document.querySelectorAll('#settings-pane-network h1, #settings-pane-network h2, #settings-pane-network h3, #settings-pane-network h4, #settings-pane-network h5, #settings-pane-network h6')].filter(h => h.getClientRects().length > 0).map(h => Number(h.tagName[1]))`);
        assert.equal(levels[0], 4, 'the pane title is the first heading: ' + levels);
        assert.ok(levels.every((l, i) => i === 0 ? true : l >= 5), 'every heading under the pane title is h5 or h6: ' + levels);
        assert.ok(levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1), 'no heading skips a level going down: ' + levels);
        console.log('5. a password field is named by its label, not by its Show button; the CLI paths disclosure has one marker');
        const pw = await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'password_ui.js'); const f = m.passwordField({ id: 'x-pw', label: 'Current password', autocomplete: 'current-password', name: 'current-password' }); document.body.append(f.root); const lab = f.root.querySelector('label'); const r = { forId: lab.htmlFor, labelText: lab.textContent, buttonInsideLabel: !!lab.querySelector('button'), toggleLabel: f.root.querySelector('.pw-toggle').getAttribute('aria-label') }; f.root.remove(); return r; })()`);
        assert.deepEqual(pw, { forId: 'x-pw', labelText: 'Current password', buttonInsideLabel: false, toggleLabel: 'Show current password' });
        await open('agents');
        assert.equal(await ev(`getComputedStyle(document.querySelector('.settings-cli-details > summary')).listStyleType`), 'none', 'the native marker is off: the one "▸" is the only marker');
        console.log('6. General\'s update switch is told apart from Updates\' (#7360): the browser\'s notice, with a line that says where downloading and installing are');
        await open('general');
        const gen = await ev(`(() => { const i = document.getElementById('settings-check-updates'); const row = i.closest('.settings-row') || i.closest('dd') || i.parentElement.parentElement; return { label: i.closest('label') ? i.closest('label').textContent.replace(/\\s+/g, ' ').trim() : '', row: row.textContent.replace(/\\s+/g, ' ').trim() }; })()`);
        assert.ok(gen.row.startsWith('Tell me when a new version is out'), 'the switch is named for what it does: ' + JSON.stringify(gen));
        assert.ok(/A notice in this browser\. Downloading and installing are under Updates\./.test(gen.row), 'and says where the rest is: ' + JSON.stringify(gen));
        console.log('PASS Settings names and heading order');
    } finally { await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
