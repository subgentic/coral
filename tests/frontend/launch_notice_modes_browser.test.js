// The "Before starting" confirmation names the members whose mode is their own (#16500, Beta tester on #16387): a team whose QA Engineer is in the custom mode "Edits ok" does not read "agents default to auto mode" alone.
// The real confirmation, opened the way a refused launch opens it (confirmLaunchDisclosure with the launch payload), 1280 px; the custom mode is in the page's own state, nothing is acknowledged or launched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const S = `(window.__coralStatic || '/static/')`;
        await ev(`import(${S} + 'state.js').then(m => { m.state.customModes = [{ id: 'm1', agent_type: 'claude', name: 'Edits ok', flags: [], risky: false }]; return true; })`);
        const ask = async (name, payload) => {
            await ev(`window.__asked = null; import(${S} + 'launch_disclosure.js').then(m => m.confirmLaunchDisclosure('local', { id: 'd1', text: 'Agents can act without asking you.', seen: false }, ${JSON.stringify(payload)})).then(v => { window.__asked = v; }); true`);
            await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length > 0 && document.getElementById('confirm-modal-title').textContent.trim() !== ''`, `${name}: the confirmation opens`, 8000);
            const seen = await ev(`({ title: document.getElementById('confirm-modal-title').textContent.trim(), message: document.getElementById('confirm-modal-message').textContent })`);
            await shot('notice-' + name);
            await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
            await waitFor(`window.__asked === false`, `${name}: Cancel closes it and starts nothing`, 5000);
            return seen;
        };
        const plain = await ask('plain', { agents: [{ name: 'Orchestrator' }, { name: 'QA Engineer' }] });
        assert.equal(plain.title, 'Agents launch in auto mode', 'members all in the default: the notice is as it was');
        assert.equal(plain.message, 'Agents can act without asking you.', 'and its text is the server\'s alone');
        const mixed = await ask('mixed', { agents: [{ name: 'Orchestrator' }, { name: 'QA Engineer', permission_mode: 'custom:m1' }, { name: 'Dev' }] });
        assert.equal(mixed.title, 'Most agents launch in auto mode', 'one member has its own mode: not every agent defaults to auto');
        assert.ok(mixed.message.startsWith('Agents can act without asking you.') && mixed.message.endsWith('Not in auto mode: QA Engineer (Edits ok).'), 'the member and its mode are named: ' + mixed.message);
        // #18765: the dialog names where the default is changed and the name is a link that opens it (Settings > Defaults), not a launch
        await ev(`window.__asked = null; import(${S} + 'launch_disclosure.js').then(m => m.confirmLaunchDisclosure('local', { id: 'd1', text: 'Agents can act without asking you.', seen: false }, ${JSON.stringify({ agents: [{ name: 'Orchestrator' }] })})).then(v => { window.__asked = v; }); true`);
        await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length > 0 && !!document.getElementById('confirm-modal-link')`, 'the confirmation has a Settings > Defaults link', 8000);
        assert.equal(await ev(`document.getElementById('confirm-modal-link').textContent.trim()`), 'Open Settings > Defaults', 'the link names the real place');
        await ev(`document.getElementById('confirm-modal-link').click(); true`);
        await waitFor(`window.__asked === false`, 'the link closes the question as a Cancel: nothing launches', 5000);
        await waitFor(`(() => { const p = document.getElementById('settings-pane-agents'); return !!p && !p.hidden && p.getClientRects().length > 0; })()`, 'Settings opens on Defaults', 8000);
        console.log('launch_notice_modes: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
