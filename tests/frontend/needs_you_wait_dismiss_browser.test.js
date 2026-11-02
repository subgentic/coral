// #11946 (the Operator's bug): an agent's Needs you row stayed after its questions were answered and offered no way to dismiss it. Every waiting-agent row has a Dismiss now: a permission, question or plan on an awake
// agent clears Coral's record of the wait (the server, as before); any other request (an input prompt, a sign-in) and an agent's request from before it went to sleep is hidden on this page for that request
// only (the agent's next request comes back), and nothing is sent to the agent. Hidden rows leave the list and the count. 1280 px, isolated dev server; the agents are rows of the page's live list.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.removeItem('coral-asked-dismissed'); localStorage.removeItem('coral-waits-ignored'); localStorage.removeItem('coral-inbox-needs-filters'); window.__posts = [];
            const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                if (m === 'POST' && /\\/dismiss-wait$/.test(url)) { window.__posts.push({ url, body: JSON.parse(o.body) }); return Promise.resolve(new Response(JSON.stringify({ ok: true, dismissed: true }), { headers: { 'content-type': 'application/json' } })); }
                return real(u, o); }; true`);
        const SINCE = '2026-11-02T01:00:00Z';
        await ev(`(() => {
            window.__m.add('inputter', 'I', 3, {}); window.__m.add('signer', 'S', 3, {}); window.__m.add('sleeper', 'Z', 3, { sleeping: true, sleep_reason: 'coral_stopped' }); window.__m.add('permit', 'P', 3, {});
            const row = id => window.T.state.liveSessions.find(s => s.session_id === id);
            Object.assign(row('inputter-id'), { waiting_for_input: true, waiting_kind: 'other', waiting_summary: 'Needs input: pick a colour', waiting_since: '${SINCE}' });
            Object.assign(row('signer-id'), { waiting_for_input: true, waiting_kind: 'login', waiting_summary: 'Sign in to continue', waiting_since: '${SINCE}' });
            Object.assign(row('permit-id'), { waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: npm test', waiting_since: '${SINCE}' });
            row('sleeper-id').asked_before_restart = { text: 'Wants to know: which font', kind: 'question', at: '${SINCE}', after_restart: true };
            window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
        const waiting = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); return m.waitingCount(); })()`);
        assert.equal(await waiting(), 4, 'four agents wait on the person');
        await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')); true`);
        const rowOf = who => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.textContent.includes(${JSON.stringify(who)}))`;
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 4`, 'the four rows', 10000);
        const dismissOf = who => ev(`!!(${rowOf(who)} || document.body).querySelector('.inbox-dismiss')`);
        for (const [who, words] of [['inputter', 'Needs input: pick a colour'], ['signer', 'Sign in to continue'], ['sleeper', 'Wants to know: which font'], ['permit', 'Wants to run: npm test']]) {
            assert.ok(await ev(`!!(${rowOf(words)})`), `${who}: its row is listed`);
            assert.ok(await ev(`!!(${rowOf(words)}).querySelector('.inbox-dismiss')`), `${who}: its row has a Dismiss`);
        }
        // an input prompt: hidden here, nothing sent, the count follows, and it stays hidden when the list is drawn again
        await ev(`${`(${rowOf('Needs input: pick a colour')})`}.querySelector('.inbox-dismiss').click(); true`);
        await waitFor(`!(${rowOf('Needs input: pick a colour')})`, 'the input prompt row is gone', 6000);
        assert.equal(await waiting(), 3, 'and out of the count');
        await ev(`window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
        assert.equal(await waiting(), 3, 'it stays hidden when the list is drawn again');
        assert.deepEqual(await ev(`window.__posts`), [], 'nothing was sent to the machine for a request it cannot clear');
        // the agent asks something new: that request is its own
        await ev(`Object.assign(window.T.state.liveSessions.find(s => s.session_id === 'inputter-id'), { waiting_since: '2026-11-02T02:00:00Z', waiting_summary: 'Needs input: and the size?' }); true`);
        assert.equal(await waiting(), 4, 'a later request of the same agent is not hidden by it');
        // a sign-in, and a request asked before the agent went to sleep
        await ev(`(${rowOf('Sign in to continue')}).querySelector('.inbox-dismiss').click(); true`);
        await waitFor(`!(${rowOf('Sign in to continue')})`, 'the sign-in row is gone', 6000);
        await ev(`(${rowOf('Wants to know: which font')}).querySelector('.inbox-dismiss').click(); true`);
        await waitFor(`!(${rowOf('Wants to know: which font')})`, 'the asked-before row is gone', 6000);
        assert.equal(await waiting(), 2, 'both are out of the count');
        assert.deepEqual(await ev(`window.__posts`), [], 'still nothing sent');
        // a permission on an awake agent still clears Coral's record of the wait
        await ev(`(${rowOf('Wants to run: npm test')}).querySelector('.inbox-dismiss').click(); true`);
        await waitFor(`window.__posts.length === 1`, 'the permission Dismiss goes to the machine', 6000);
        assert.deepEqual(await ev(`window.__posts.map(p => p.body)`), [{ session_id: 'permit-id', agent_type: 'claude' }]);
        console.log('PASS every waiting-agent row has a Dismiss: the server clears a permission, question or plan; any other request, and one asked before sleep, is hidden for that request only');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
