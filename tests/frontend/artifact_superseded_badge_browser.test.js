// An older version of a file says it was superseded, and the "New comments" badge is not cut (#17454, walk 67 from #17361). The team page's Artifacts tab, the list stubbed in the page, 1440 px:
// v1 of plan.html (tag superseded, v2 in the list) wears "Superseded by v2" and opens v2; notes.html with new comments wears "New comments" whole (no 'New comme...').
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-sup-${Date.now() % 100000}`;
const H = c => c.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady, settle } = require('./helpers/wait').bind(ev);
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); const j = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const base = { media_type: 'text/html', size: 900, task_id: 0, task_title: '', available: true, source: 'completion', provenance: 'uploaded', produced_by: 'Lead Developer', session_id: 's1' };
        const at = n => new Date(Date.now() - n * 60000).toISOString();
        const items = [
            { ...base, id: ${JSON.stringify(H('b'))}, name: 'plan.html', created_at: at(1), uri: 'coral://artifacts/${H('b')}', file_id: 'f1' + 'a'.repeat(30), version: 2, versions: 2, version_line: 'version 2 of plan.html' },
            { ...base, id: ${JSON.stringify(H('a'))}, name: 'plan.html', created_at: at(5), uri: 'coral://artifacts/${H('a')}', file_id: 'f1' + 'a'.repeat(30), version: 1, versions: 2, tags: ['superseded'], version_line: 'version 1 of plan.html' },
            { ...base, id: ${JSON.stringify(H('c'))}, name: 'notes.html', created_at: at(3), uri: 'coral://artifacts/${H('c')}', file_id: 'f2' + 'b'.repeat(30), new_comments: 2 },
        ];
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (String((o && o.method) || 'GET').toUpperCase() === 'GET' && /^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) return j({ project: ${JSON.stringify(TEAM)}, artifacts: items, has_more: false, total: 3 });
            return R(u, o); };
        return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile, tag] of [[1440, false, 'desktop']]) { // a phone's team list is the mail row, which has no badge (the 390 px check of the Needs you badge is in needs_new_comments_browser)
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM); await stub();
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await goTab(ev, settle, 'Artifacts'); await waitFor(`document.querySelectorAll('.team-artifact-badge').length >= 2`, `${tag}: the badges`, 12000);
            const badges = await ev(`[...document.querySelectorAll('.team-artifact-badge')].map(b => ({ text: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 1, link: b.getAttribute('role') === 'link' }))`);
            const news = badges.find(b => /^New comments$/.test(b.text)), sup = badges.find(b => /^Superseded by v2$/.test(b.text));
            assert.ok(news && news.cut === false, `${tag}: "New comments" is whole, not cut: ` + JSON.stringify(badges));
            assert.ok(sup, `${tag}: the older version says "Superseded by v2": ` + JSON.stringify(badges));
            assert.ok(sup.link && sup.cut === false, `${tag}: it is whole and opens v2: ` + JSON.stringify(sup));
        }
        console.log('PASS older version says superseded by v2 and opens it; New comments whole at 1440');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
