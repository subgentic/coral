// An agent at a blocking dialog (#11430, coral-hub #139004: an agent stood on Claude Code's "trust this folder" prompt for four hours and its row said Idle): while Coral holds a board message back for a prompt on the
// agent's screen (the row's skipped_send, "a prompt is open"), its state is "At a dialog", not Idle; after the set minutes (5) it is a Needs you item, "needs one click", and counts in the Inbox badge; a prompt that has stood
// only a minute is calm. An agent that asks through its own hook keeps its own state. 1280 px, a desktop sidebar.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const ago = min => new Date(Date.now() - min * 60000).toISOString();
    const row = (id, name, extra) => Object.assign({ session_id: id, name: 'coral-' + id, display_name: name, agent_type: 'claude', model: 'claude-opus-5-5', server: 'local', board_unread: 5, working: false, context_pct: null }, extra);
    const trust = min => ({ why: 'a prompt is open: Quick safety check: Is this a project you trust?', what: 'board message', at: ago(0), since: ago(min) });
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        const rows = [row('d1', 'Security Reviewer', { skipped_send: trust(12) }), row('d2', 'Fresh Dialog', { skipped_send: trust(1) }), row('d3', 'Plain Idle', {}), row('d4', 'Own Ask', { skipped_send: trust(30), waiting_for_input: true, waiting_kind: 'permission' })];
        await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(rows)}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item').length >= 4`, 'the rows', 6000);
        const info = await ev(`import(${S} + 'session_state.js').then(m => Object.fromEntries(T.state.liveSessions.map(r => [r.display_name, m.sessionStateInfo(r).label])))`);
        check(info['Security Reviewer'] === 'At a dialog' && info['Fresh Dialog'] === 'At a dialog', 'an agent whose message waits for a prompt is At a dialog, not Idle: ' + JSON.stringify(info));
        check(info['Plain Idle'] === 'Idle', 'an agent with nothing wrong stays Idle: ' + JSON.stringify(info));
        check(/^Needs input/.test(info['Own Ask']), 'an agent that asks through its own hook keeps its own state: ' + JSON.stringify(info));
        const seen = await ev(`(() => { const r = document.querySelector('#live-sessions-list .session-group-item[data-session-id="d1"]'); return r ? r.textContent + ' ' + [...r.querySelectorAll('[aria-label],[title]')].map(e => (e.getAttribute('aria-label') || '') + ' ' + (e.title || '')).join(' ') : ''; })()`);
        check(/At a dialog/.test(seen) && !/\bIdle\b/.test(seen), 'the row itself says At a dialog: ' + seen.slice(0, 200));
        const needs = await ev(`import(${S} + 'asked_before_restart.js').then(m => T.state.liveSessions.filter(m.needsYou).map(r => r.display_name).sort())`);
        check(JSON.stringify(needs) === JSON.stringify(['Own Ask', 'Security Reviewer']), 'only the dialog that has stood 5 minutes is a Needs you item (with the agent that asks): ' + JSON.stringify(needs));
        const item = await ev(`import(${S} + 'asked_before_restart.js').then(m => { const r = m.askedRow(T.state.liveSessions.find(x => x.display_name === 'Security Reviewer')); return { summary: r.waiting_summary, kind: r.waiting_kind }; })`);
        check(item.summary === 'Needs one click: it is at a dialog' && item.kind === 'dialog', 'the Needs you row says it needs one click: ' + JSON.stringify(item));
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
        await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, 'the Inbox badge counts the dialog and the ask', 6000);
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS an agent at a dialog is "At a dialog", and needs one click after 5 minutes');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
