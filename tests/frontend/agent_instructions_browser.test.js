// Edit instructions (#10133, Beta Tester #10130): an agent's row menu has Edit instructions (not for a terminal); it opens a dialog with the saved text, says the change applies at the agent's next restart, saves through
// PUT /api/sessions/live/<name>/instructions, shows a toast that says the same, and keeps the dialog open with the reason when the server refuses. The Prompts pane's folds have plain names. 1280 px, isolated dev server, the
// agent a mock (agent_view_harness) and the PUT stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page, 'edit-instructions');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__m.add('qa-orch', 'x', 4, { sleeping: false, session_id: 'sid-instr-1' }); window.__m.add('qa-term', 'x', 2, { sleeping: false, session_id: 'sid-instr-2', agent_type: 'terminal' });` }); // the mock list has them from the first load
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { const R = window.fetch; window.__puts = []; window.__putAnswer = { status: 200, body: { ok: true, applies: 'at the next restart' } };
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (/\\/instructions$/.test(url.pathname) && (o.method || 'GET') === 'PUT') { window.__puts.push({ path: url.pathname, body: JSON.parse(o.body) }); return Promise.resolve(new Response(JSON.stringify(window.__putAnswer.body), { status: window.__putAnswer.status, headers: { 'Content-Type': 'application/json' } })); } return R(u, o); }; return true; })()`);
        const row = sid => `document.querySelector('#live-sessions-list li[data-session-id="${sid}"]')`;
        const openMenu = async sid => { await ev(`${row(sid)}.querySelector('.sidebar-kebab-btn').click(); true`); await waitFor(`!!${row(sid)}.querySelector('[data-on-click="agent-rename"], [data-on-click="agent-info"]')`, 'the row menu', 6000); };
        const items = async sid => { await openMenu(sid); const r = await ev(`[...${row(sid)}.querySelectorAll('.sidebar-kebab-menu [data-on-click]')].map(b => b.dataset.onClick)`); await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); return r; };
        console.log('1. an agent has Edit instructions in its menu; a terminal does not');
        await waitFor(`!!document.querySelector('#live-sessions-list [data-session-id="sid-instr-1"]')`, 'the agent rows', 15000);
        assert.ok((await items('sid-instr-1')).includes('agent-instructions'), 'the agent has it');
        assert.ok(!(await items('sid-instr-2')).includes('agent-instructions'), 'a terminal does not');

        console.log('2. it opens the dialog, says when it applies, and saves');
        await openMenu('sid-instr-1'); await ev(`${row('sid-instr-1')}.querySelector('[data-on-click="agent-instructions"]').click(); true`);
        await waitFor(`!!document.getElementById('instructions-dialog') && document.getElementById('instructions-dialog').open`, 'the dialog', 6000);
        assert.match(await ev(`document.getElementById('instructions-lead').textContent`), /next time the agent restarts/);
        await shot('dialog-1280');
        await ev(`(() => { const t = document.getElementById('instructions-text'); t.value = 'Review only; never push.'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#instructions-dialog button[type=submit]').click(); return true; })()`);
        await waitFor(`window.__puts.length === 1 && !document.getElementById('instructions-dialog').open`, 'the save and the dialog closing', 6000);
        const put = await ev(`window.__puts[0]`);
        assert.match(put.path, /\/api\/sessions\/live\/[^/]+\/instructions$/); assert.equal(put.body.session_id, 'sid-instr-1'); assert.equal(put.body.instructions, 'Review only; never push.');
        assert.match(await ev(`[...document.querySelectorAll('.toast, [role=status]')].map(e => e.textContent).join(' | ')`), /next time it restarts/, 'the toast says when it applies');

        console.log('3. a refusal is said in the dialog, which stays open');
        await ev(`window.__putAnswer = { status: 403, body: { error: 'Only the Operator can do this.' } }; true`); await openMenu('sid-instr-1'); await ev(`${row('sid-instr-1')}.querySelector('[data-on-click="agent-instructions"]').click(); true`);
        await waitFor(`document.getElementById('instructions-dialog').open`, 'the dialog again', 6000);
        assert.equal(await ev(`document.getElementById('instructions-text').value`), 'Review only; never push.', 'it shows the saved text');
        await ev(`document.querySelector('#instructions-dialog button[type=submit]').click(); true`);
        await waitFor(`!!document.querySelector('#instructions-dialog .field-error:not([hidden])')`, 'the reason', 6000);
        assert.match(await ev(`document.querySelector('#instructions-dialog .field-error').textContent`), /Only the Operator/);
        assert.ok(await ev(`document.getElementById('instructions-dialog').open`), 'the dialog stays open');
        console.log('PASS edit instructions');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
