// Phone polish from the v2.0.21 walk (#11694, #11693), at 390: (1) the Scroll tabs chevron has a lane of its own and covers no tab or badge; (2) a toast starts below the Inbox's tab strip and covers none of its tabs. The route stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const WORLD = `(() => {
    const real = window.fetch; const at = m => new Date(Date.now() - m * 60000).toISOString();
    const A = Array.from({ length: 13 }, (_, i) => ({ id: String(i + 1).padStart(64, '0'), name: 'report-' + (i + 1) + '.md', media_type: 'text/markdown', size: 1000 * (i + 1), created_at: at(5 + i * 5), available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha', tags: ['for review'] }));
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/team-artifacts' && m === 'GET') return json({ artifacts: A, limit: 13, offset: 0, has_more: true, truncated: false, total: 34, all: 60, tag_counts: { 'for review': 31 }, teams: [{ board_id: 'alpha', team: 'alpha', all: 60 }] }); // the server's total for the filter (34) is not the pill's count (31)
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${WORLD}`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 13`, 'the rows', 10000);
        // (1) the chevron has a lane of its own: the tab strip ends where it begins
        await waitFor(`!!document.querySelector('.view-list-nav[data-overflow]') && !!document.querySelector('.view-list-edge-tap:not([hidden])')`, 'the strip scrolls and the chevron is drawn', 8000);
        const lane = await ev(`(() => { const nav = document.querySelector('.view-list-nav[data-overflow]'), btn = document.querySelector('.view-list-edge-tap'); if (!nav || !btn || btn.hidden) return null; const n = nav.getBoundingClientRect(), b = btn.getBoundingClientRect(); return { navRight: Math.round(n.right), chevronLeft: Math.round(b.left) }; })()`);
        check(!!lane && lane.navRight <= lane.chevronLeft + 1, 'the Scroll tabs chevron covers no tab: ' + JSON.stringify(lane));
        // (2) a toast starts below the tab strip
        await ev(`import(${S} + 'notifications.js').then(m => { m.showToast('Approved report-1.md.'); return true; })`);
        await waitFor(`!!document.querySelector('#toast-host .toast')`, 'the toast', 4000);
        await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: the column places itself after the toast is drawn
        await shot('phone-polish-390');
        const over = await ev(`(() => { const nav = document.querySelector('.view-list-nav'), t = document.getElementById('notices'); if (!nav || !t) return null; return { navBottom: Math.round(nav.getBoundingClientRect().bottom), toastTop: Math.round(t.getBoundingClientRect().top) }; })()`);
        check(!!over && over.toastTop >= over.navBottom, 'the toast is below the tab strip: ' + JSON.stringify(over));
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('phone_polish_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
