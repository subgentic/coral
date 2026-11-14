// Needs you on a tablet (#15259, walk 13 H2/M4/L15): at 820 px the table keeps a gutter on both sides, every chip is whole on the screen (they wrap onto their own line), Answer and Dismiss sit inside the card, an answer sent
// from the dialog says 'Reply sent.', and once nothing is left the list says 'You are all caught up'. The asks and the board's message route are stubbed in the page; a real isolated server serves it.

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
        for (const [w, h, mobile] of [[820, 1180, false], [768, 1024, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { window.__asks = [{ board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'wait', id: 0, asker: 'QA', text: '@Operator waiting for your word on the release', at: new Date(Date.now() - 600000).toISOString() }];
                window.__closes = []; window.__refuse = ''; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { window.__asks = []; return json({ id: 99 }); }
                    const m = /^\\/api\\/board\\/([^/]+)\\/asks\\/(\\d+)\\/close$/.exec(url);
                    if (m && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__closes.push({ board: m[1], id: Number(m[2]), body }); if (window.__refuse) return json({ error: window.__refuse }, 409); if (body.undo) window.__asks.push({ board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date().toISOString() }); else window.__asks = window.__asks.filter(a => !(a.kind === 'ask' && a.id === Number(m[2]))); return json({ ok: true }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length === 2`, at + 'the question and the wait', 10000);
            const open = who => ev(`document.querySelector('button[aria-label="Answer the question of ${who}"]').click(); true`);

            const m = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; };
                const T = document.querySelector('#group-table-view'), tbl = T.querySelector('table, .dt-table') || T;
                return { vw: innerWidth, sw: document.documentElement.scrollWidth, table: r(tbl), out: [...document.querySelectorAll('.inbox-folder-toolbar .gt-toolbar *')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().right > innerWidth - 8 || e.getBoundingClientRect().left < 8)).map(e => e.className + ' ' + Math.round(e.getBoundingClientRect().left) + '-' + Math.round(e.getBoundingClientRect().right)).slice(0, 6),
                    pills: [...document.querySelectorAll('.inbox-folder-toolbar .team-tb-pills')].filter(e => e.getClientRects().length).map(e => e.scrollWidth - e.clientWidth), btns: [...T.querySelectorAll('tbody tr:not(.dt-group) button')].filter(b => /^(Answer|Dismiss)/.test(b.textContent.trim())).map(b => ({ t: b.textContent.trim(), ...r(b) })) }; })()`);
            check(at + 'no sideways scroll', m.sw <= m.vw + 1, JSON.stringify(m));
            check(at + 'the table keeps a gutter of at least 16 px on both sides', m.table.l >= 16 && m.table.r <= m.vw - 16, JSON.stringify(m.table));
            check(at + 'every control of the title line is whole on the screen', m.out.length === 0, JSON.stringify(m.out));
            check(at + 'no chip is hidden by sideways scrolling', m.pills.every(d => d <= 0), JSON.stringify(m.pills));
            check(at + 'Answer and Dismiss are inside the table', m.btns.length >= 2 && m.btns.every(b => b.l >= m.table.l && b.r <= m.table.r), JSON.stringify(m.btns));
            // answer it from the dialog: the toast, then the empty list's words
            await open('Dev'); await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open] .inbox-ask-box')`, at + 'the dialog opens', 4000);
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog .inbox-ask-box'); b.value = 'Yes, use 8450'; b.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('dialog.inbox-ask-dialog .inbox-ask-send').click(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('.toast')].some(e => /Reply sent/.test(e.textContent))`, at + 'the toast says Reply sent', 6000).catch(() => check(at + 'the toast says Reply sent', false));
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'the dialog closes', 4000);
            await ev(`window.__asks = []; true`);
            await waitFor(`/You are all caught up/.test(document.querySelector('#group-table-view').innerText) || /You are all caught up/.test(document.body.innerText)`, at + 'the empty list says it', 8000).catch(() => check(at + 'the empty list says You are all caught up', false));
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_tablet_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
