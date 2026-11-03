// The quiet "Muted by your settings" line when the ONLY files for review are muted (#12881, QA's walk, B1): the page had the muted file but the Needs you table was not redrawn for a change that only moved muted files, so
// the line appeared only after leaving the tab and coming back. The suite's other fixture also has a visible file, which hid it. Here every file is muted. At 1440 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const real = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                const hex = c => c.repeat(64), at = i => new Date(Date.now() - i * 3600000).toISOString();
                const file = (c, name, extra) => ({ id: hex(c), name, uri: 'coral://artifacts/' + hex(c), digest: hex(c), available: true, tags: ['for review'], created_at: at(3), ...extra });
                const files = [file('b', 'release-notes.md', { kind: 'release', muted: true }), file('d', 'decisions.md', { kind: 'decided', muted: true })];
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href);
                    if (url.pathname === '/api/board/projects') return json([{ project: 'alpha' }]);
                    if (url.pathname === '/api/board/alpha/artifacts' && url.searchParams.get('tag') === 'for review') return new Promise(r => setTimeout(() => r(json({ artifacts: files, has_more: false })), 900)); // the read ends AFTER the folder first drew (nothing to show yet)
                    if (url.pathname === '/api/board/alpha/artifacts') return json({ artifacts: [], has_more: false });
                    return real(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('.inbox-muted-line')`, `${tag}: the quiet Muted line on the FIRST view`, 8000).catch(() => {});
            const line = await ev(`(() => { const p = document.querySelector('.inbox-muted-line'); return p ? p.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
            check(`${tag}: only muted files exist: the quiet line is there on the first view, without leaving the tab`, /^Muted by your settings: 1 release summary, 1 decision made for you\. Show them$/.test(line || ''), JSON.stringify(line));
            check(`${tag}: and nothing is counted`, (await ev(`import(${S} + 'inbox_reviews.js').then(m => m.unreadReviewItems().length)`)) === 0);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} muted-only checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
