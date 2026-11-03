// The panel of an agent's unread team messages (#12713, the Operator's screenshot: no way to dismiss them, a count of 12 over fifty rows back to Oct 26, the list filling the composer, and "Coral's messages wait
// until you stop typing" standing above the box all the time). An agent with 3 unread messages: the line says 3, the list holds those 3 (newest first, all open: no Show all), Dismiss marks them read through the
// newest one shown WITHOUT typing anything into the agent (no /send, no /keys) and the line goes. An agent with 8: three rows are open and the rest are behind Show all, and the list scrolls inside a bounded box so
// the message box stays on the screen. The typing hint shows only while a message is waiting, never as a standing line. At 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__m.add('dm-agent', 'A', 3, { sleeping: false }); true`);
            await sleep(600); // sleep-ok: the first live list renders from several answers; no single completion event
            await ev(`window.selectLiveSession('dm-agent', 'claude', 'dm-agent-id', 'local'); true`);
            await sleep(500); // sleep-ok: a selection settles over frames
            // the server's answers: what waits (the list of the count's messages), and what Dismiss was asked
            await ev(`(() => { window.__calls = []; window.__msgs = []; window.__realFetch = window.fetch;
                const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const s = String(u); const url = new URL(s, location.href);
                    if (/\\/api\\/sessions\\/live\\/dm-agent\\/waiting\\/dismiss$/.test(url.pathname)) { const body = JSON.parse(o.body); window.__calls.push({ what: 'dismiss', body }); const n = window.__msgs.filter(m => m.id <= body.through_id).length; window.__msgs = window.__msgs.filter(m => m.id > body.through_id); return json({ ok: true, dismissed: n, unread: window.__msgs.length }); }
                    if (/\\/api\\/sessions\\/live\\/dm-agent\\/waiting$/.test(url.pathname)) return json({ board: 'team', unread: window.__msgs.length, messages: window.__msgs, skipped: null });
                    if (/\\/api\\/sessions\\/live\\/dm-agent\\/(waiting\\/send|send|keys)$/.test(url.pathname)) { window.__calls.push({ what: 'typed', path: url.pathname }); return json({ ok: true, sent: true }); }
                    return window.__realFetch(u, o); }; return true; })()`);
            const seed = n => ev(`(() => { window.__msgs = Array.from({ length: ${n} }, (_, i) => ({ id: 21 + i, sender: ['Orchestrator', 'Backend Dev', 'QA Engineer'][i % 3], at: new Date(Date.now() - (${n} - i) * 60000).toISOString(), text: 'message number ' + (i + 1) + ' ' + 'x'.repeat(200), truncated: false }));
                const rows = window._coralGetLiveSessions().map(r => r.session_id === 'dm-agent-id' ? { ...r, board_unread: ${n}, skipped_send: { why: 'a prompt is open', what: 'board message', at: new Date().toISOString(), since: new Date().toISOString() } } : r); window._coralSetLiveSessions(rows);
                return import(${S} + 'waiting.js').then(m => { m.syncWaitingNotice(rows.find(r => r.session_id === 'dm-agent-id')); return true; }); })()`);
            const view = () => ev(`(() => { const vis = e => !!e && !e.hidden && e.getClientRects().length > 0;
                const t = document.getElementById('composer-waiting-text'), d = document.getElementById('composer-waiting-detail'), items = document.getElementById('composer-waiting-items'), box = document.getElementById('command-input');
                const rows = [...items.querySelectorAll(':scope > details')], hidden = [...items.querySelectorAll('#composer-waiting-more details')];
                const more = document.getElementById('composer-waiting-more'), all = items.querySelector('.composer-waiting-all');
                const ir = items.getBoundingClientRect(), br = box.getBoundingClientRect();
                return { text: t.textContent, open: vis(d), rows: rows.length, behind: hidden.length, moreShown: vis(more), all: all ? all.textContent : null, dismiss: vis(document.getElementById('composer-waiting-dismiss')), itemsH: Math.round(ir.height), scrolls: items.scrollHeight > items.clientHeight + 1, boxOnScreen: br.top >= 0 && br.bottom <= innerHeight && br.height > 0, bar: (() => { const b = document.getElementById('notice-pause-bar'); return !!b && b.getBoundingClientRect().height > 1 && b.querySelector('.notice-pause-text').textContent !== ''; })() }; })()`);
            const openList = async () => { await ev(`document.getElementById('composer-waiting-list').click(); true`); await waitFor(`!document.getElementById('composer-waiting-detail').hidden && document.querySelectorAll('#composer-waiting-items > details, #composer-waiting-items > p').length > 0`, 'the list opens', 6000); };

            // 3 unread: the count, the list and Dismiss
            await seed(3);
            let v = await view();
            check(`${tag}: three unread: the line says 3`, v.text === '3 team messages have not reached this agent yet', JSON.stringify(v));
            await openList();
            v = await view();
            check(`${tag}: the list holds those 3, all open, with no Show all`, v.rows === 3 && v.behind === 0 && v.all === null, JSON.stringify(v));
            const order = await ev(`[...document.querySelectorAll('#composer-waiting-items > details .composer-waiting-body')].map(p => p.textContent.slice(0, 16))`);
            check(`${tag}: the list is newest first (the server's oldest-first order is reversed by the page)`, JSON.stringify(order) === JSON.stringify(['message number 3', 'message number 2', 'message number 1']), JSON.stringify(order));
            check(`${tag}: Dismiss is offered, and the message box stays on the screen`, v.dismiss && v.boxOnScreen, JSON.stringify(v));
            await ev(`document.getElementById('composer-waiting-dismiss').click(); true`);
            await waitFor(`window.__calls.some(c => c.what === 'dismiss')`, 'Dismiss asks the server', 6000);
            const calls = await ev(`window.__calls`);
            check(`${tag}: Dismiss names the newest message it was shown (23), and nothing was typed into the agent`, calls.length === 1 && calls[0].what === 'dismiss' && calls[0].body.through_id === 23 && calls[0].body.session_id === 'dm-agent-id', JSON.stringify(calls));
            await waitFor(`document.getElementById('composer-waiting-text').textContent === ''`, 'the line goes', 6000);
            v = await view();
            check(`${tag}: the panel is gone after Dismiss and no hint stands in its place`, !v.open && v.text === '' && !v.dismiss && !v.bar, JSON.stringify(v));

            // 8 unread: three open, the rest behind Show all, bounded
            await ev(`window.__calls = []; true`);
            await seed(8);
            await openList();
            v = await view();
            check(`${tag}: eight unread: three rows open, five behind Show all`, v.rows === 3 && v.behind === 5 && !v.moreShown && v.all === 'Show all 8', JSON.stringify(v));
            check(`${tag}: the list is a bounded box, and the message box is still on the screen`, v.itemsH <= Math.min(h * 0.3, 260) + 2 && v.boxOnScreen, JSON.stringify(v));
            await ev(`document.querySelector('#composer-waiting-items .composer-waiting-all').click(); document.querySelectorAll('#composer-waiting-items details').forEach(d => { d.open = true; }); true`); // every row's text open: the long case
            v = await view();
            check(`${tag}: Show all opens the other five, and the list scrolls inside its bounded box`, v.moreShown && v.all === 'Show fewer' && v.boxOnScreen && v.scrolls && v.itemsH <= Math.min(h * 0.3, 260) + 2, JSON.stringify(v));

            // the typing hint: only while a message is waiting
            await ev(`document.getElementById('composer-waiting-dismiss').click(); true`);
            await waitFor(`document.getElementById('composer-waiting-text').textContent === ''`, 'the line goes', 6000);
            const hint = extra => ev(`(() => { const rows = window._coralGetLiveSessions().map(r => r.session_id === 'dm-agent-id' ? { ...r, notices_paused: false, paused_until: null, notices_holding: true, board_unread: 0, ...${JSON.stringify(extra)} } : r); window._coralSetLiveSessions(rows);
                return import(${S} + 'session_header_updates.js').then(m => { m.updateWaitingIndicator(rows.find(r => r.session_id === 'dm-agent-id')); return true; }); })()`);
            await hint({});
            check(`${tag}: typing with nothing waiting: no hint above the box`, !(await view()).bar, JSON.stringify(await view()));
            await hint({ board_unread: 2 });
            check(`${tag}: typing with a message waiting: the hint shows`, (await view()).bar === true);
            await hint({ board_unread: 0 });
            check(`${tag}: delivered: the hint goes`, !(await view()).bar);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} unread team message panel checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
