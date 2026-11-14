// Needs you's filters (#15259, walk 15 M2/M4): a team filter kept from last time says 'Filtered by team: X' above the list with a Clear button that brings the rows back, and the Filters panel opens over the list on a computer
// (the list does not move down). The asks are stubbed in the page; a real isolated server serves it.

const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: `try { if (!sessionStorage.getItem('f15259')) { sessionStorage.setItem('f15259', '1'); localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ team: 'zz-no-such-team' })); } } catch (e) {}` }); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false]]) {
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
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('.inbox-folder-toolbar')`, at + 'the Needs you page', 10000);
            const open = who => ev(`document.querySelector('button[aria-label="Answer the question of ${who}"]').click(); true`);


            const noteOf = () => ev(`(() => { const n = document.querySelector('.inbox-filter-note'); return n ? { text: n.textContent.trim(), btn: !!n.querySelector('button'), rows: document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length } : null; })()`);
            await waitFor(`!!document.querySelector('.inbox-filter-note')`, at + 'the filter line', 8000).catch(() => {});
            const n0 = await noteOf();
            check(at + 'a kept team filter says so above the list, with Clear', n0 && /^Filtered by team: zz-no-such-team/.test(n0.text) && n0.btn, JSON.stringify(n0));
            await ev(`document.querySelector('.inbox-filter-note button').click(); true`);
            await waitFor(`!document.querySelector('.inbox-filter-note') && document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length >= 1`, at + 'Clear brings the rows back', 8000).catch(async () => check(at + 'Clear removes the line and brings the rows back: ' + JSON.stringify(await ev(`({ note: !!document.querySelector('.inbox-filter-note'), rows: document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length, saved: localStorage.getItem('coral-inbox-needs-filters'), text: document.querySelector('#group-table-view').innerText.slice(0, 200) })`)), false));
            check(at + 'one skip link, not one more per redraw', (await ev(`document.querySelectorAll('#group-table-view .skip-link').length`)) === 1);
            const top = () => ev(`Math.round(document.querySelector('#group-table-view tbody tr:not(.dt-group)').getBoundingClientRect().top)`);
            const t0 = await top();
            await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle, .inbox-folder-toolbar .list-bar-filter-btn').click(); true`);
            await waitFor(`!!document.querySelector('.inbox-folder-toolbar .list-bar-menu') && getComputedStyle(document.querySelector('.inbox-folder-toolbar .list-bar-menu')).display !== 'none'`, at + 'the panel opens', 4000);
            await ev(`document.fonts.ready.then(() => true)`);
            const t1 = await top();
            check(at + 'the Filters panel opens over the list: the list does not move (' + t0 + ' -> ' + t1 + ')', Math.abs(t1 - t0) <= 2);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_filter_note_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
