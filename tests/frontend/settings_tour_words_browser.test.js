// Settings tour words (#10324, Desktop #10321): each setting says in plain words what it does or what it risks, before the switch. One section per pane. 1280 px, real isolated server; the settings guard puts
// the shard's settings back. The text read is the row's (hidden More text too), so a sentence behind More counts.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const guard = await require('./helpers/settings_guard').guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const row = id => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); const r = e && (e.closest('.settings-row, .sv-row') || e.parentElement); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    const options = id => ev(`[...document.getElementById(${JSON.stringify(id)}).options].map(o => o.textContent.trim())`);
    const text = id => ev(`(document.getElementById(${JSON.stringify(id)}) || {}).textContent && document.getElementById(${JSON.stringify(id)}).textContent.replace(/\\s+/g, ' ').trim()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return import(${MOD} + 'modals.js'); }).then(m => m.showSettingsModal('general')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-group-by-team') && !!document.getElementById('settings-remote-access-enabled') && !!document.getElementById('tb-choice')`, 'the Settings rows', 10000);

        // PANE General
        assert.match(await row('settings-group-by-team'), /Group agents by team/, 'General: the grouping says team, not "board or team"');
        assert.doesNotMatch(await row('settings-group-by-team'), /board or team/, 'General: one word for it');
        assert.match(await row('settings-group-by-team'), /Agents on the same team sit together in the list/, 'General: and what it does');
        // END General

        // PANE Terminal
        assert.deepEqual(await options('tb-choice'), ['Keep agents running when Coral restarts (tmux)', 'Put agents to sleep when Coral restarts (pty, default)'], 'Terminal: the choices say what happens to agents, with the technical name after');
        
        assert.equal(await ev(`document.querySelector('#settings-engine-more > summary').textContent.trim()`), 'Terminal drawing', 'Terminal: the disclosure says what it is for, in the same two words as before');
        assert.equal(await text('settings-renderer-select-label'), 'Drawing engine', 'Terminal: Default render engine is the drawing engine');
        assert.equal(await ev(`document.getElementById('settings-renderer-select').title`), 'Leave this unless the terminal text looks wrong.', 'Terminal: and when to touch it, on the select (no new visible words)');
        // END Terminal

        // PANE Files and Git
        assert.deepEqual(await options('settings-file-search-mode'), ['Browse folders', 'Match any part of a name'], 'Files and Git: the two ways say what they do');
        assert.match(await row('settings-file-search-mode'), /How @ mentions and the file browser find files/, 'Files and Git: and what they are for');
        // END Files

        // PANE Storage
        assert.equal(await text('settings-storage-shrink'), 'Shrink saved diffs…', 'Storage: Shrink says what it shrinks');
        // END Storage

        // PANE Security
        assert.match(await row('settings-debug-input-log'), /Record what Coral types \(debug\)/, 'Security: the switch says what it records');
        assert.match(await row('settings-debug-input-log'), /including anything typed or pasted, such as passwords/, 'Security: and that it records secrets');
        // END Security

        // PANE Agents
        assert.match(await row('settings-codex-trust-hooks'), /Skip Codex's review of Coral's hooks/, 'Agents: the switch names what it skips');
        assert.match(await row('settings-codex-trust-hooks'), /Turns off a safety check/, 'Agents: and says it turns off a safety check');
        assert.ok((await options('settings-permission-mode')).includes('Bypass permissions (turns off safety checks)'), 'Agents: Bypass permissions says what it does');
        // END Agents

        // PANE Network
        assert.match(await row('settings-remote-access-enabled'), /Lets other devices use Coral as you do \(control agents, read files, change settings\); unencrypted unless TLS is set up\./, 'Network and Hub: Remote access says its risk before the switch');
        assert.match(await row('settings-hub-mode-enabled'), /Adds a Servers tab; whoever signs in here controls every computer you add\./, 'Network and Hub: Manage other computers says its risk before the switch');
        // END Network
        console.log('PASS Settings tour words');
    } finally { await client.close(); await guard.restore(); }
})().catch(e => { console.error(e); process.exit(1); });
