// A team's Artifacts tab opened for a name no board has (#8821): the board route answers 404 board_not_found ("No team named <name>") and the page says that, with no Retry (asking again cannot find a team that is
// not there), instead of "no artifacts" (which the route used to answer with 200 and an empty list) or a generic failure. A team that exists still lists. Against a stubbed board route. 1280 and 390.
// Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const REAL = 'nf-team-' + Date.now().toString(36);
const ITEMS = ['plan.md'].map((name, i) => ({ name, media_type: 'text/markdown', size: 2048, task_id: 100 + i, task_title: 'Task ' + i, produced_by: 'qa-bot', created_at: new Date().toISOString(), uri: 'coral://artifacts/' + '1'.repeat(64) }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { const R = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (url.pathname === '/api/board/no-such-team/artifacts') return json({ error: 'No team named no-such-team', code: 'board_not_found' }, 404);
                    if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname) && (o.method || 'GET') === 'GET') return json({ project: decodeURIComponent(url.pathname.split('/')[3]), artifacts: ${JSON.stringify(ITEMS)}, limit: 50, offset: 0, has_more: false, truncated: false, total: 1, all: 1 });
                    if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
                    return R(u, o); }; return true; })()`);
            for (const team of [REAL, 'no-such-team']) {
                await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(team)}, { tab: 'artifacts' }); true`);
                await waitFor(`!!document.querySelector('#team-panel-artifacts') && !document.querySelector('#team-panel-artifacts').hidden`, `${label}: the Artifacts tab`, 10000);
                await settle(900);
                const s = await ev(`({ rows: document.querySelectorAll('#team-panel-artifacts tbody tr').length, error: ((document.querySelector('#team-panel-artifacts .team-artifacts-error') || {}).textContent || '').trim(), retry: !!document.querySelector('#team-panel-artifacts .team-artifacts-retry') })`);
                if (team === REAL) check(`${label}: a team that exists lists its file, no error`, s.rows === 1 && !s.error, JSON.stringify(s));
                else check(`${label}: a name no board has says "No team named no-such-team", with no Retry`, /^No team named no-such-team/.test(s.error) && !s.retry && s.rows === 0, JSON.stringify(s));
            }
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} team artifacts not-found checks passed`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
