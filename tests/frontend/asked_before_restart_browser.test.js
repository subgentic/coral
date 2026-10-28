// A question an agent asked before Coral restarted is not lost (#10368, Mobile #10360): a restart ends a pty agent's CLI, and its open question used to vanish (Needs you empty, the chat showing only the sent
// line). The server says it on the sleeping agent's row (asked_before_restart); Needs you lists the agent with "Asked before Coral restarted: <question>", and the chat says the same with Restart and
// Dismiss, no answer buttons (the CLI that asked is gone). Dismissing removes it from both, for that request only. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); localStorage.removeItem('coral-asked-dismissed'); true`);
        const ASKED = { text: 'Wants to know: which colour for the header', kind: 'question', at: '2026-10-28T10:00:00Z' };
        await ev(`(() => {
            window.__m.add('asker', 'A', 3, { sleeping: true, sleep_reason: 'coral_stopped' });
            window.__m.add('quiet', 'Q', 3, { sleeping: true, sleep_reason: 'coral_stopped' });
            window.__m.add('shelved', 'S', 3, { sleeping: true, archived: true });
            const row = id => window.T.state.liveSessions.find(s => s.session_id === id); // the mock's rows carry the fields it knows: the server's new one is set on them
            row('asker-id').asked_before_restart = ${JSON.stringify(ASKED)}; row('quiet-id').asked_before_restart = null; row('shelved-id').asked_before_restart = ${JSON.stringify(ASKED)};
            window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
        const waiting = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); return m.waitingCount(); })()`);
        assert.equal(await waiting(), 1, 'Needs you counts the agent that asked before the restart, not the quiet one or the archived one');
        // Needs you lists it with its words
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the Inbox draws its first folder
        const needs = await ev(`document.body.innerText`);
        assert.match(needs, /Asked before Coral restarted: Wants to know: which colour for the header/, 'the Needs you row carries the question: ' + needs.slice(0, 300));
        // the chat says it, with Restart and Dismiss and no answer buttons
        await ev(`window.switchNavTab('agents'); true`);
        const chat = await ev(`(async () => { window.selectLiveSession('asker', 'claude', 'asker-id', 'local'); await window.__coralReady.agentSelected('asker-id');
            const box = document.getElementById('sleeping-composer-asked'), t = document.getElementById('sleeping-composer-asked-text');
            return { shown: !box.hidden, text: t.textContent, dismiss: !!document.getElementById('sleeping-asked-dismiss'), restart: !document.getElementById('sleeping-restart-btn').hidden, answers: document.querySelectorAll('.cni-answer').length }; })()`);
        assert.deepEqual([chat.shown, chat.dismiss, chat.restart, chat.answers], [true, true, true, 0], JSON.stringify(chat));
        assert.equal(chat.text, 'Asked before Coral restarted: Wants to know: which colour for the header');
        // the quiet one says nothing
        const quiet = await ev(`(async () => { window.selectLiveSession('quiet', 'claude', 'quiet-id', 'local'); await window.__coralReady.agentSelected('quiet-id'); return !document.getElementById('sleeping-composer-asked').hidden; })()`);
        assert.equal(quiet, false, 'an agent that asked nothing says nothing');
        // Dismiss: gone from the chat and from Needs you, kept for that request, and a new request is not hidden by it
        await ev(`window.selectLiveSession('asker', 'claude', 'asker-id', 'local'); window.__coralReady.agentSelected('asker-id').then(() => document.getElementById('sleeping-asked-dismiss').click()); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the dismiss redraws the chat and Needs you
        assert.equal(await ev(`document.getElementById('sleeping-composer-asked').hidden`), true, 'dismissed in the chat');
        assert.equal(await waiting(), 0, 'dismissed from Needs you');
        await ev(`window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
        assert.equal(await waiting(), 0, 'it stays dismissed when the list is drawn again');
        await ev(`window.T.state.liveSessions.find(s => s.session_id === 'asker-id').asked_before_restart = { ...${JSON.stringify(ASKED)}, at: '2026-10-28T11:00:00Z', text: 'Wants to know: and the font?' }; true`);
        assert.equal(await waiting(), 1, 'a later request of the same agent is its own');
        console.log('PASS asked before restart: Needs you, the chat with Restart and Dismiss, dismissed per request');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
