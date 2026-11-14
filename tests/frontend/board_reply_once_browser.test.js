// A reply sent from an open board message shows once (walk 46, #17019): the thread said "Replies (2)" with two You rows while the board held one message. On the team's Board and on the Inbox's Board history, 1280 px:
// open a message, press Reply, send, and when the reply has arrived the message lists one reply, there is one row for it and the rows' ids are all different. Real board over the API through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const B = 'reply1-' + Date.now().toString(36), problems = [];
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const post = async (who, content) => { const r = await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content }); assert.equal(r.status, 200, 'post: ' + JSON.stringify(r)); return r.json.id; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status, 200);
        const first = await post('Boss', 'Status of the recipe book?');
        for (const t of ['Index page is up.', 'Styles next.', 'Then the print layout.']) await post('Boss', t); // the message is not the newest: a reply to it is drawn under it, not at the end
        let replies = 0;
        for (const [label, path] of [['team Board', `/team/${B}/messages`], ['Board history', `/inbox/boards/${B}`]]) {
            replies++; // each pass adds the person's reply (the agent's answer adds another below)
            await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await coralReady();
            await waitFor(`!!document.querySelector('#mb-messages > .mb-message[data-message-id="${first}"]')`, `${label}: the message`, 15000);
            const rowSel = `#mb-messages > .mb-message[data-message-id="${first}"]`;
            await ev(`document.querySelector('${rowSel} > .mb-row-toggle').click(); true`); await settle(150);
            await ev(`[...document.querySelector('${rowSel} .mb-row-actions').querySelectorAll('button')].forEach(b => { if (b.textContent === 'Reply') b.click(); }); true`); await settle(150);
            const text = `my reply on ${label}`;
            await ev(`(() => { const i = document.getElementById('mb-post-input'); i.value += ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#mb-board .mb-post-send-btn').click(); return true; })()`);
            await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Boss', content: 'PINEAPPLE ' + label, reply_to: first }); replies++; // the agent answers within seconds, while the poll for the person's own reply may be running
            await waitFor(`[...document.querySelectorAll('#mb-messages > .mb-message')].some(r => (r.textContent || '').includes(${JSON.stringify(text)}))`, `${label}: the reply is drawn`, 15000);
            await settle(1500); // a poll or a push may bring it again
            const s = await ev(`(() => { const rows = [...document.querySelectorAll('#mb-messages > .mb-message')], ids = rows.map(r => r.dataset.messageId), mine = rows.filter(r => (r.querySelector('.mb-message-body') || r).textContent.includes(${JSON.stringify(text)})); const title = document.querySelector('${rowSel} .mb-row-replies-title'); return { ids, dup: ids.filter((x, i) => ids.indexOf(x) !== i), mine: mine.length, title: title ? title.textContent : null, items: document.querySelectorAll('${rowSel} .mb-row-reply').length }; })()`);
            if (s.dup.length || s.mine !== 1 || s.items !== replies || s.title !== `Replies (${replies})`) problems.push(`${label}: the reply shows once: ` + JSON.stringify(s));
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'a reply:\n  ' + problems.join('\n  '));
    console.log('PASS a reply from an open board message shows once');
})().catch(e => { console.error(e.message); process.exit(1); });
