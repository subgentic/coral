// Dismiss in a question's reply dialog (#12599, the Operator): a question can be closed with no answer from the dialog it opens, as the row's own Dismiss closes it: the board's close route with the fixed note, nothing said to the agent,
// a toast with Undo, the question gone from Needs you. A wait has no ask row to close, so its dialog has no Dismiss. Escape and Close still close the dialog and dismiss nothing; a refused close says why and keeps the dialog.
// 1280 and 390 px; the asks and the close route are stubbed in the page (as in ask_item_browser), a real isolated server serves the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { window.__asks = [{ board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'wait', id: 0, asker: 'QA', text: '@Operator waiting for your word on the release', at: new Date(Date.now() - 600000).toISOString() }];
                window.__closes = []; window.__refuse = ''; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    const m = /^\\/api\\/board\\/([^/]+)\\/asks\\/(\\d+)\\/close$/.exec(url);
                    if (m && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__closes.push({ board: m[1], id: Number(m[2]), body }); if (window.__refuse) return json({ error: window.__refuse }, 409); if (body.undo) window.__asks.push({ board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date().toISOString() }); else window.__asks = window.__asks.filter(a => !(a.kind === 'ask' && a.id === Number(m[2]))); return json({ ok: true }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'the question and the wait', 10000);
            const open = who => ev(`document.querySelector('button[aria-label="Answer the question of ${who}"]').click(); true`);
            const dismissIn = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'); const b = d && [...d.querySelectorAll('.inbox-ask-buttons button')].find(x => x.textContent.trim() === 'Dismiss'); return b ? { text: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), order: [...d.querySelectorAll('.inbox-ask-buttons button')].map(x => x.textContent.trim()) } : null; })()`);

            // a wait has no Dismiss
            await open('QA'); await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the wait dialog opens', 4000);
            check(at + 'a wait has no Dismiss', (await dismissIn()) === null);
            await ev(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button').click(); true`);
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'the dialog closes', 4000);

            // Escape and Close dismiss nothing
            await open('Dev'); await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the question dialog opens', 4000);
            const d = await dismissIn();
            check(at + 'a question has Dismiss between Close and Send reply', !!d && JSON.stringify(d.order) === JSON.stringify(['Close', 'Dismiss', 'Send reply']), JSON.stringify(d));
            check(at + 'Dismiss is a touch target', !!d && d.h >= (mobile ? 44 : 28), JSON.stringify(d));
            await ev(`document.querySelector('dialog.inbox-ask-dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })); true`);
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'Escape closes the dialog', 4000);
            check(at + 'Escape dismissed nothing', (await ev(`window.__closes.length`)) === 0);

            // a refused close says why and keeps the dialog and the question
            await open('Dev'); await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the dialog opens again', 4000);
            await ev(`window.__refuse = 'the question is already closed'; [...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button')].find(x => x.textContent.trim() === 'Dismiss').click(); true`);
            await waitFor(`/already closed/.test((document.querySelector('dialog.inbox-ask-dialog .inbox-ask-error') || {}).textContent || '')`, at + 'the refusal is said in the dialog', 4000);
            check(at + 'a refused Dismiss keeps the dialog open and the button usable', await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'); return !!d && ![...d.querySelectorAll('.inbox-ask-buttons button')].find(x => x.textContent.trim() === 'Dismiss').disabled; })()`));

            // Dismiss closes the question quietly, with Undo
            await ev(`window.__refuse = ''; [...document.querySelectorAll('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button')].find(x => x.textContent.trim() === 'Dismiss').click(); true`);
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'the dialog closes on Dismiss', 6000);
            await waitFor(`window.__closes.length === 2`, at + 'the close route is called', 4000);
            const c = await ev(`window.__closes[1]`);
            check(at + 'the close is the board route with the fixed note and nothing else', c.board === 'team' && c.id === 42 && JSON.stringify(c.body) === JSON.stringify({ note: 'Dismissed by the operator' }), JSON.stringify(c));
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, at + 'a toast says it, with Undo', 4000);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'the question leaves Needs you', 6000);
            await ev(`[...document.querySelectorAll('.toast')].find(t => /Dismissed/.test(t.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); }); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'Undo brings the question back', 6000);
            check(at + 'the question is back in Needs you after Undo', await ev(`!!document.querySelector('button[aria-label="Answer the question of Dev"]')`));
        }
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('ask_dialog_dismiss_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
