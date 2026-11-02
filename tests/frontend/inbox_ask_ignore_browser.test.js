// Ignore on a question to the Operator (#11552, the approved action set): an ask has an Ignore beside Reply, a `wait --operator` (no ask row, no close route) has none; Ignore calls the board's close route with the fixed note
// "Dismissed by the operator" and nothing else (no message, no reply), the question leaves Needs you and a toast offers Undo, which calls the route with undo:true and brings the question back; the focus goes to the
// next row. The asks and the close route stubbed in the page, as the Lead's server answers. 1440 (the table) and 390 (the phone's rows).
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { installGuard, reached } = require('./helpers/silent_dismiss');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { window.__asks = [{ board: 'team', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: '2026-10-31T01:00:00Z' }, { board: 'team', kind: 'ask', id: 42, asker: 'Docs', text: 'Which heading style?', at: '2026-10-31T02:00:00Z' }, { board: 'team', kind: 'wait', id: 7, asker: 'Dev', text: 'may I delete the old table?', at: '2026-10-31T03:00:00Z' }];
                window.__calls = []; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET'; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    const m = url.match(/^\\/api\\/board\\/team\\/asks\\/(\\d+)\\/close$/);
                    if (m && method === 'POST') { const body = JSON.parse(o.body); window.__calls.push({ id: Number(m[1]), body });
                        if (body.undo) { if (!window.__closed) window.__closed = []; const a = window.__closed.find(x => x.id === Number(m[1])); if (a) { window.__asks.push(a); window.__closed = window.__closed.filter(x => x !== a); } return json({ ok: true, reopened: true }); }
                        const a = window.__asks.find(x => x.id === Number(m[1])); window.__asks = window.__asks.filter(x => x !== a); (window.__closed = window.__closed || []).push(a); return json({ ok: true, closed_by: 'Operator' }); }
                    return orig(u, o); }; return true; })()`);
            await installGuard(ev);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'three rows of Needs you', 10000);
            const ignores = await ev(`[...document.querySelectorAll('${T} button[aria-label^="Ignore the question of"]')].map(b => b.getAttribute('aria-label'))`);
            if (mobile) { // a phone row has no Ignore button (#11642): Ignore is in its three-dot menu, so the two asks have a menu and the wait has none
                const menus = await ev(`[...document.querySelectorAll('${T} .inbox-row-more-toggle')].map(b => b.getAttribute('aria-label')).sort()`);
                check(JSON.stringify(ignores) === '[]' && JSON.stringify(menus) === JSON.stringify(['More actions for the question of Docs', 'More actions for the question of Lead']), at + 'no Ignore button; the two asks have a menu, the wait has none: ' + JSON.stringify({ ignores, menus }));
                await ev(`document.querySelector('${T} .inbox-row-more-toggle[aria-label="More actions for the question of Lead"]').click(); true`);
                await waitFor(`!!document.querySelector('${T} .inbox-row-more .menu:not([hidden]) .menu-item')`, at + 'the menu opens', 5000);
                await ev(`document.querySelector('${T} .inbox-row-more .menu:not([hidden]) .menu-item').click(); true`);
            } else {
                check(JSON.stringify(ignores.sort()) === JSON.stringify(['Ignore the question of Docs', 'Ignore the question of Lead']), at + 'the two asks have an Ignore, the wait has none: ' + JSON.stringify(ignores));
                await ev(`document.querySelector('${T} button[aria-label="Ignore the question of Lead"]').click(); true`);
            }
            await waitFor(`!document.querySelector('${T} button[aria-label="Answer the question of Lead"]')`, at + 'the ignored question leaves', 8000).catch(() => {});
            await ev(framesJs(6));
            const calls = await ev(`window.__calls`);
            check(calls.length === 1 && calls[0].id === 41 && calls[0].body.note === 'Dismissed by the operator' && !calls[0].body.undo, at + 'one close call with the fixed note: ' + JSON.stringify(calls));
            check((await reached(ev)).length === 0, at + 'nothing was posted to the board: ' + JSON.stringify(await reached(ev)));
            const toast = await ev(`(() => { const t = [...document.querySelectorAll('.toast')].find(x => /Ignored "Which port should the test server use.*from Lead/.test(x.textContent)); return t ? { undo: !!([...t.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo')) } : null; })()`);
            check(!!toast && toast.undo, at + 'a toast says it, with Undo: ' + JSON.stringify(toast));
            check(await ev(`document.querySelectorAll('${T} tbody tr').length === 2`), at + 'two rows are left');
            await ev(`[...document.querySelectorAll('.toast')].find(x => /Ignored "Which port should the test server use.*from Lead/.test(x.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); }); true`);
            await waitFor(`!!document.querySelector('${T} button[aria-label="Answer the question of Lead"]')`, at + 'Undo brings the question back', 8000).catch(() => {});
            const all = await ev(`window.__calls`);
            check(all.length === 2 && all[1].body.undo === true && !all[1].body.note, at + 'Undo is the same route with undo:true and no note: ' + JSON.stringify(all));
            check((await reached(ev)).length === 0, at + 'nor did Undo post anything');
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_ask_ignore_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
