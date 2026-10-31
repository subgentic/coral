// The Inbox Artifacts document pane on a phone (#11400, the v2.0.10 phone walk): opened from the real route (the Inbox's Artifacts folder, a row), the pane is the whole screen and its action row (Open, Download, Copy link,
// Delete) sits ABOVE the floating nav (not under it), every action is a whole 44 px button inside the screen, and the title area is not a box that ends before the right edge. 390 and 320 px, light and dark.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const hex = n => String(n).padStart(64, '0');
const WORLD = `(() => {
    const real = window.fetch; window.__ta = [];
    const at = m => new Date(Date.now() - m * 60000).toISOString();
    const A = [
        { n: 1, name: 'beta-notes.txt', mt: 'text/plain', board: 'beta', m: 5, task: 12, title: 'Write the notes' },
        { n: 2, name: 'alpha-report.md', mt: 'text/markdown', board: 'alpha', m: 20, task: 7, title: 'Build the report' },
        { n: 3, name: 'beta-data.json', mt: 'application/json', board: 'beta', m: 40, task: 11, title: 'Export the data' },
        { n: 4, name: 'alpha-chart.png', mt: 'image/png', board: 'alpha', m: 60, task: 8, title: 'Draw the chart' },
        { n: 5, name: 'alpha-plan.md', mt: 'text/markdown', board: 'alpha', m: 90, task: 6, title: 'Plan the work' },
    ].concat(Array.from({ length: 35 }, (_, i) => ({ n: 6 + i, name: 'report-' + (6 + i) + '.md', mt: 'text/markdown', board: i % 2 ? 'alpha' : 'beta', m: 100 + i * 5, task: 20 + i, title: 'Task number ' + i }))).map(a => ({ id: String(a.n).padStart(64, '0'), name: a.name, media_type: a.mt, size: 1000 * a.n, created_at: at(a.m), task_id: a.task, task_title: a.title, source: 'task', uri: 'coral://artifacts/' + String(a.n).padStart(64, '0'),
        available: true, inline: false, reference_count: 1, board_id: a.board, team: a.board }));
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/team-artifacts' && m === 'GET') {
            window.__ta.push(url.search);
            const teams = url.searchParams.getAll('team'), q = (url.searchParams.get('q') || '').toLowerCase();
            const rows = A.filter(a => (!teams.length || teams.includes(a.board_id)) && (!q || a.name.includes(q)));
            const limit = Number(url.searchParams.get('limit') || 100);
            return json({ artifacts: rows.slice(0, limit), limit, offset: 0, has_more: rows.length > limit, truncated: false, total: rows.length, all: A.length,
                teams: [{ board_id: 'alpha', team: 'alpha', all: 20 }, { board_id: 'beta', team: 'beta', all: 20 }] });
        }
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        let r = /^\\/api\\/artifacts\\/([0-9a-f]{64})$/.exec(p);
        if (r && m === 'GET') return Promise.resolve(new Response('the text of ' + r[1].replace(/^0+/, ''), { status: 200, headers: { 'content-type': 'text/plain' } }));
        if (/^\\/api\\/artifacts\\/[0-9a-f]{64}\\/(meta|readers|comments)/.test(p)) return json({ error: 'not found' }, 404);
        return real(u, o);
    };
    return true; })()`;


(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme] of [[390, 'dark'], [390, 'light'], [320, 'dark']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            const tag = `${w} ${theme}`;
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${WORLD}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('#group-table-view tbody tr').length >= 30`, `${tag}: the rows`, 10000);
            await ev(`document.querySelectorAll('#group-table-view tbody .dt-primary')[1].click(); true`);
            await waitFor(`(() => { const p = document.querySelector('.inbox-detail-pane'); return !!p && !p.hidden && /alpha-report/.test(p.textContent); })()`, `${tag}: the pane`, 8000);
            await settle(600); await shot(`inbox-artifact-${w}-${theme}`);
            const g = await ev(`(() => { const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden', pane = document.querySelector('.inbox-detail-pane'), nav = document.getElementById('phone-nav'), n = getComputedStyle(nav).display === 'none' ? null : nav.getBoundingClientRect(), pr = pane.getBoundingClientRect();
                const btns = [...pane.querySelectorAll('button, a.btn, a[href]')].filter(vis).filter(b => /Open|Download|Copy|Delete|Close/i.test((b.getAttribute('aria-label') || b.textContent))), rects = btns.map(b => { const r = b.getBoundingClientRect(); return { n: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 14), t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; });
                const head = pane.querySelector('.detail-head, .detail-title, h2, h3'), hr = head ? head.getBoundingClientRect() : null, hs = head ? getComputedStyle(head) : null;
                const tr = pane.querySelector('.phone-title-row'); return { rowBg: tr ? getComputedStyle(tr).backgroundColor : null, paneBg: getComputedStyle(pane).backgroundColor, navTop: n ? Math.round(n.top) : 9999, vh: innerHeight, vw: innerWidth, paneR: Math.round(pr.right), rects, head: hr ? { w: Math.round(hr.width), r: Math.round(hr.right), bg: hs.backgroundColor } : null }; })()`);
            assert.ok(g.rects.length >= 3, `${tag}: the pane has its actions: ` + JSON.stringify(g));
            assert.ok(g.rects.every(r => r.b <= g.navTop - 4 && r.l >= 0 && r.r <= g.vw && r.h >= 44), `${tag}: every action sits above the floating nav (top ${g.navTop}), inside the screen, 44 px high: ` + JSON.stringify(g));
            assert.ok(g.rowBg === null || g.rowBg === 'rgba(0, 0, 0, 0)' || g.rowBg === g.paneBg, `${tag}: the title row has no fill of its own (the walk's dark box, two thirds wide): ` + JSON.stringify([g.rowBg, g.paneBg]));
            assert.ok(!g.head || g.head.r >= g.vw - 16, `${tag}: the title area reaches the right edge (a box that ends at two thirds is the walk's black box): ` + JSON.stringify(g.head));
        }
        console.log('PASS the Inbox artifact pane on a phone: its actions are above the nav, the title area is whole');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
