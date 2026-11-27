// A reply shows once even when the board changes around it (walk 56, #17644; #17019's pin covered only the plain path): the person's reply is drawn under the message it answers (a thread draws a reply away from its place
// in time), and a plain message that arrives after it, or a slow round trip of the reply's own POST, must not draw that reply a second time at the end ("Replies (2)" with two You rows until a reload).
// Team Board and Inbox Teams, 1280 px. Real board over the API; the POST's answer is delayed 2.5 s in the page, and a poll (the 10 s timer's, here pollBoardNow) runs while it is out.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const B = 'replyrace-' + Date.now().toString(36), problems = [];
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const post = async (who, content, extra = {}) => { const r = await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content, ...extra }); assert.equal(r.status, 200, 'post: ' + JSON.stringify(r)); return r.json.id; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status, 200);
        const first = await post('Boss', 'Status of the recipe book?');
        for (const t of ['Index page is up.', 'Styles next.']) await post('Boss', t);
        let shownReplies = 0, plain = 0;
        for (const [label, path] of [['team Board', `/team/${B}/messages`], ['Teams', `/inbox/boards/${B}`]]) {
            shownReplies++;
            await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await coralReady();
            const rowSel = `#mb-messages > .mb-message[data-message-id="${first}"]`;
            await waitFor(`!!document.querySelector('${rowSel}')`, `${label}: the message`, 15000);
            await ev(`document.querySelector('${rowSel} > .mb-row-toggle').click(); true`); await settle(150);
            await ev(`[...document.querySelector('${rowSel} .mb-row-actions').querySelectorAll('button')].forEach(b => { if (b.textContent === 'Reply') b.click(); }); true`); await settle(150);
            const text = `my slow reply on ${label}`;
            await ev(`(() => { const f = window.fetch; window.fetch = (u, o) => { const p = f(u, o); return o && o.method === 'POST' && String(u).endsWith('/messages') ? p.then(r => new Promise(res => setTimeout(() => res(r), 2500))) : p; }; return true; })()`); // the reply's answer is slow
            await ev(`(() => { const i = document.getElementById('mb-post-input'); i.value += ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#mb-board .mb-post-send-btn').click(); return true; })()`);
            await settle(300); // the server has the reply; the page has not heard back
            await ev(`window.__coral.pollBoardNow().then(() => true)`); // the timer's poll brings it, drawn under its message
            await waitFor(`[...document.querySelectorAll('#mb-messages > .mb-message')].some(r => (r.textContent || '').includes(${JSON.stringify(text)}))`, `${label}: the reply is drawn by the poll`, 15000);
            plain++; await post('Boss', `PLAIN after the reply on ${label}`); // an agent's plain message lands after the reply
            await ev(`window.__coral.pollBoardNow().then(() => true)`);
            await waitFor(`[...document.querySelectorAll('#mb-messages > .mb-message')].some(r => (r.textContent || '').includes('PLAIN after the reply on ${label}'))`, `${label}: the plain message is drawn`, 15000);
            await settle(3200); // the delayed POST answers now and polls again
            const s = await ev(`(() => { const rows = [...document.querySelectorAll('#mb-messages > .mb-message')], ids = rows.map(r => r.dataset.messageId), mine = rows.filter(r => (r.querySelector('.mb-message-body') || r).textContent.includes(${JSON.stringify(text)})); const title = document.querySelector('${rowSel} .mb-row-replies-title'); return { ids, dup: ids.filter((x, i) => ids.indexOf(x) !== i), mine: mine.length, title: title ? title.textContent : null, items: document.querySelectorAll('${rowSel} .mb-row-reply').length }; })()`);
            if (s.dup.length || s.mine !== 1 || s.items !== shownReplies || s.title !== `Replies (${shownReplies})`) problems.push(`${label}: the reply shows once: ` + JSON.stringify(s));
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'a reply:\n  ' + problems.join('\n  '));
    console.log('PASS a reply shows once with a slow POST and a plain message after it');
})().catch(e => { console.error(e.message); process.exit(1); });
