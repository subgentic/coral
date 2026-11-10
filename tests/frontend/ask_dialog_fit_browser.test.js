// The question dialog on a phone and a computer (#15232, walks 6 and 11): Close and Dismiss sit in the header beside the title (a question has a visible Dismiss, a wait has only Close), and the reply box and
// Send reply are on the screen with the dialog scrolled to its start AND to its end, never under a floating bar. 1280 and 390 px, 200% text; the asks are stubbed in the page.

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

            for (const who of ['Dev', 'QA']) {
                await open(who); await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + who + ' dialog opens', 4000);
                const m = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog[open]'), q = s => d.querySelector(s); const r = e => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
                    const head = q('.inbox-ask-head'), h2 = head && head.querySelector('h2'), btns = [...d.querySelectorAll('.inbox-ask-buttons button')].map(b => ({ t: b.textContent.trim(), ...r(b) }));
                    d.scrollTop = d.scrollHeight; const box = r(q('.inbox-ask-box')), send = r(q('.inbox-ask-send')), dlg = r(d);
                    return { head: !!head, inHead: !!head && btns.length > 0 && [...d.querySelectorAll('.inbox-ask-buttons button')].every(b => head.contains(b)), titleInHead: !!h2, btns, box, send, dlg, vh: innerHeight }; })()`);
                check(at + who + ': Close (and a question\'s Dismiss) are in the header with the title', m.head && m.inHead && m.titleInHead, JSON.stringify(m));
                check(at + who + ': a wait has only Close, a question has Close and Dismiss', who === 'QA' ? m.btns.length === 1 : m.btns.some(b => b.t === 'Dismiss') && m.btns.some(b => b.t === 'Close'), JSON.stringify(m.btns));
                check(at + who + ': header buttons are in the first screenful', m.btns.every(b => b.top >= 0 && b.bottom <= m.vh), JSON.stringify(m.btns));
                check(at + who + ': reply box and Send reply are on the screen and the box is above Send', m.box.top >= 0 && m.send.bottom <= m.vh && m.box.bottom <= m.send.top + 1, JSON.stringify({ box: m.box, send: m.send, vh: m.vh }));
                await ev(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-buttons button').click(); true`);
                await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'the dialog closes', 4000);
            }
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('ask_dialog_fit_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
