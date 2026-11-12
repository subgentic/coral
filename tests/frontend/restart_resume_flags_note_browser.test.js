// #15761 (follow-up of #15735): Restart's settings step and Resume's mode picker say what the flags are and why they differ from the pick, as New agent step 3 does: one preview call
// (POST /api/launch/permission-args), the real server answers. Restart: the line is on the settings step only; Resume: under the mode note, none for the saved default.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { const S = window.__coralStatic || '/static/'; window.T = { state: (await import(S + 'state.js')).state, stage: (await import(S + 'restart_flow.js')).restartStage }; await (await import(S + 'lazy_panels.js')).loadModals(); return true; })()`);
        const text = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e && !e.hidden && e.getClientRects().length ? e.textContent : null; })()`);

        // Restart: a Codex agent whose role narrows Bypass with a Shell rule.
        const session = { name: 'cx', display_name: 'Coder', session_id: 'sid-rf', type: 'live', agent_type: 'codex', model: '', prompt: 'Be kind.', capabilities: { allow: ['shell'], deny: ['git_write'] }, permission_mode: 'bypassPermissions' };
        await ev(`T.state.currentSession = ${JSON.stringify(session)}; window.restartSession(); true`);
        await waitFor(`getComputedStyle(document.getElementById('restart-modal')).display !== 'none' && !!document.querySelector('#restart-acf .acf-permission-mode')`, 'the restart dialog', 8000);
        assert.equal(await text('#restart-flags'), null, 'no flags line on the persona step');
        await ev(`T.stage('agent'); true`);
        await waitFor(`(document.getElementById('restart-flags').textContent || '').includes('narrow this mode')`, 'the reason on the settings step', 8000);
        const r = await text('#restart-flags');
        assert.match(r, /Adds .* to the command\./, 'it names what is added: ' + r);
        await ev(`T.stage('back'); true`);
        await waitFor(`document.getElementById('restart-flags').hidden`, 'the line goes with the settings step', 4000);
        console.log('   ok Restart: ' + r.slice(0, 120));

        // Resume: a Codex chat; Default plus a mode, then the saved default.
        await ev(`(() => { const m = document.getElementById('resume-modal'); m.dataset.agentType = 'codex'; const s = document.getElementById('resume-mode'); s.replaceChildren(...[['', 'Saved default'], ['bypassPermissions', 'Bypass permissions'], ['default', 'Default']].map(([v, t]) => new Option(t, v))); document.getElementById('resume-mode-row').hidden = false; return true; })()`);
        const pick = v => ev(`(() => { const s = document.getElementById('resume-mode'); s.value = ${JSON.stringify(v)}; window.syncResumeModeNote(); return true; })()`);
        await pick('bypassPermissions');
        await waitFor(`(document.getElementById('resume-flags').textContent || '').includes('Adds')`, 'the flags for Bypass', 8000);
        const b = await ev(`document.getElementById('resume-flags').textContent`); // the modal is not opened here: its text, not its box
        await pick('default');
        await waitFor(`(document.getElementById('resume-flags').textContent || '') !== ${JSON.stringify(b)} && !document.getElementById('resume-flags').hidden`, 'the line follows the pick', 8000);
        await pick('');
        await waitFor(`document.getElementById('resume-flags').hidden`, 'the saved default has no line', 4000);
        console.log('   ok Resume: ' + b.slice(0, 120));
        console.log('PASS Restart and Resume say what the flags are');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
