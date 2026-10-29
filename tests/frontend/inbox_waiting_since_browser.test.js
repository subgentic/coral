// The Inbox's Needs you row says how long an agent has waited, from the live row's waiting_since (#7004, #6981): "waiting 4 min" as text in the row (not a hover title), nothing when
// waiting_since is null, and the words move on as time passes. Real isolated server, mock agents. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => { window.__m.add('QA Alpha', 'A', 4, { sleeping: false, session_id: 'qa-a-id' }); window.__m.add('FE Alpha', 'B', 4, { sleeping: false, session_id: 'fe-a-id' }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, 'two agents', 8000);
        const set = since => ev(`(async () => { const w = ${JSON.stringify(since)};
            window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_since: w[s.session_id] === undefined ? null : w[s.session_id] }));
            (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
        const WHEN = `[...document.querySelectorAll('#group-table-view thead th')].findIndex(h => h.textContent.replace(/[↑↓↕]/g, '').trim() === 'Waiting')`; // the column moves when a row has a folder or a question
        // an empty cell is a dash for the eye and "none" for a screen reader
        const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => ({ id: tr.querySelector('.dt-primary').dataset.sessionId, waited: tr.cells[${WHEN}].textContent.trim().replace(/^\u2014none$/, ''), title: tr.cells[${WHEN}].title || '', text: tr.textContent }))`);
        const ago = m => new Date(Date.now() - m * 60000).toISOString();
        await set({ 'qa-a-id': ago(4) });
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!document.getElementById('inbox-local').hidden && document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'the Needs you table', 8000);
        let r = await rows(); const a = id => r.find(x => x.id === id);
        assert.equal(a('qa-a-id').waited, 'waiting 4 min', 'the row says how long, as text');
                assert.equal(a('qa-a-id').title, '', 'not a hover title');
        assert.equal(a('fe-a-id').waited, '', 'a null waiting_since says nothing');
        assert.ok(!/waiting \d|waiting under/.test(a('fe-a-id').text), 'and no guess');
        console.log('PASS the row says "waiting 4 min" and nothing for null');
        await set({ 'qa-a-id': ago(7), 'fe-a-id': ago(130) });
        await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr')].every(tr => tr.cells[${WHEN}].textContent.trim())`, 'both waits drawn', 8000);
        r = await rows();
        assert.equal(a('qa-a-id').waited, 'waiting 7 min'); assert.equal(r.find(x => x.id === 'fe-a-id').waited, 'waiting 2 h 10 min');
        // time passes with no new feed message: the 30-second tick redraws it, and a row the keyboard is on keeps it (UI Accessibility's #7004 review)
        await ev(`document.querySelector('#group-table-view .dt-primary[data-session-id="qa-a-id"]').focus(); true`);
        await ev(`window.__realNow = Date.now; Date.now = () => window.__realNow() + 3 * 60000; true`);
        await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr')].some(tr => tr.cells[${WHEN}].textContent.trim() === 'waiting 10 min')`, 'the wait moves on by itself', 40000);
        assert.equal(await ev(`document.activeElement.classList.contains('dt-primary') && document.activeElement.dataset.sessionId`), 'qa-a-id', 'focus stays on the row after the redraw');
        console.log('PASS it updates as time passes, and keeps the focused row');
        console.log('PASS Inbox waiting_since');
    } finally { await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
