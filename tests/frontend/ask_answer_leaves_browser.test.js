// An answered question leaves Needs you at once (#17501, walk 72 M6): with the pointer resting on the list, a reply sent from a question's dialog took about 25 s to leave, the title count stayed, and a
// "Some new waiting. Show" pill appeared with nothing new behind it. The person's own answer redraws the table once, not held under the pointer, and the held-rows line is only for rows that are really new.
// 1280 px (a pointer that rests is a mouse); the asks and the board post are stubbed in the page, as in ask_dialog_dismiss_browser; a real isolated server serves the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, Input, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => { window.__asks = [{ board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 43, asker: 'QA', text: '@Operator ship the release?', at: new Date(Date.now() - 600000).toISOString() }];
            const orig = window.fetch.bind(window);
            window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                if (url === '/api/operator-asks') return json(window.__asks);
                if (/^\\/api\\/board\\/team\\/messages/.test(url) && o && o.method === 'POST') { const b = JSON.parse(o.body); window.__asks = window.__asks.filter(a => a.id !== b.reply_to); return json({ id: 900 }); }
                return orig(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'both questions are listed', 10000);
        // the pointer rests on the other question's row
        const p = await ev(`(() => { const r = document.querySelectorAll('#group-table-view tbody tr')[1].getBoundingClientRect(); return { x: Math.round(r.left + 120), y: Math.round(r.top + r.height / 2) }; })()`);
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y });
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the pointer events reach the page
        await ev(`document.querySelector('button[aria-label="Answer the question of Dev"]').click(); true`);
        await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, 'the dialog opens', 4000);
        await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'); const t = d.querySelector('.inbox-ask-box'); t.value = 'Yes, go ahead.'; t.dispatchEvent(new Event('input', { bubbles: true })); d.querySelector('.inbox-ask-send').click(); return true; })()`);
        await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, 'the dialog closes', 6000);
        await new Promise(r => setTimeout(r, 700)); // sleep-ok: well under the 25 s the walk saw, and past the redraw
        const st = await ev(`({ rows: document.querySelectorAll('#group-table-view tbody tr').length, dev: !!document.querySelector('button[aria-label="Answer the question of Dev"]'), note: (document.querySelector('#group-table-view .group-table-held') || {}).textContent || '' })`);
        check('the answered question has left the list at once', st.rows === 1 && !st.dev, JSON.stringify(st));
        check('no "new waiting" line for nothing new', st.note === '', JSON.stringify(st));
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('ask_answer_leaves_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
