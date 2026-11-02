// The page does not move when the icon font arrives (#12354: on Linux a scrolled Needs you list shrank about 184 px a quarter second after its first scroll): an icon is a word ("notifications") that the Material Icons font draws as a
// glyph, so before the font is in, the word itself takes the room (the font is font-display: block, and a Linux Chrome can take a while). Each icon is a 1em box either way, so the layout of a page with the fonts blocked
// is the layout of a page with them loaded. Nine Needs you rows at 420 px and 1280 px, the web fonts blocked by URL against loaded: the page's height, the table's and every row's are equal.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const Network = client.Network, team = 'fs-' + Date.now().toString(36), out = [];
    try {
        await Page.enable(); await Network.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[420, 800, true], [1280, 800, false]]) for (const block of [false, true]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Network.setBlockedURLs({ urls: block ? ['*.woff2'] : [] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer'})}).then(r => r.status)`);
            await ev(`(() => { const mk = n => ({ id: n.toString(16).padStart(64, '0'), name: 'A review file with a fairly long name number ' + n + ' for the whole company.md', media_type: 'text/markdown', size: 3000, created_at: new Date(Date.now() - n * 600000).toISOString(), tags: ['for review'], available: true, produced_by: 'Review Writer', uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0') }); const items = [1,2,3,4,5,6,7,8,9].map(mk), base = window.fetch;
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (url.pathname === '/api/board/${team}/artifacts') return Promise.resolve(new Response(JSON.stringify({ project: '${team}', artifacts: items.filter(a => !url.searchParams.has('tag') || a.tags.includes(url.searchParams.get('tag'))), has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return base(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 9`, 'rows', 12000); await ev(framesJs(10));
            out.push([w, block, await ev(`(() => { const t = document.querySelector('#group-table-view'), tr = [...t.querySelectorAll('tbody tr')].map(r => Math.round(r.getBoundingClientRect().height)); return { rows: tr.length, heights: tr.join(','), box: Math.round(t.getBoundingClientRect().height), page: document.documentElement.scrollHeight, fam: getComputedStyle(document.body).fontFamily.slice(0, 40), loaded: document.fonts.status }; })()`)]);
        }
        for (const w of [420, 1280]) { const a = out.find(o => o[0] === w && !o[1])[2], b = out.find(o => o[0] === w && o[1])[2];
            assert.deepEqual([b.page, b.box, b.heights], [a.page, a.box, a.heights], `${w}: the page with the web fonts blocked is laid out as the page with them loaded (page ${b.page} vs ${a.page}, table ${b.box} vs ${a.box}); an icon's name is not allowed to take room before its font arrives`); }
    } finally { await Network.setBlockedURLs({ urls: [] }).catch(() => {}); await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    console.log('font_swap_shift_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
