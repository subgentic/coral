// The Inbox Artifacts folder's document pane is a proper right sidebar (#8925, the Operator's shot: it floated as a card and squeezed the Name column): flush to the view's right edge, as tall as the view, a grip
// on its left edge that drags (and has the keys), the width remembered per browser, the list keeping at least 480 px at the widest; at 390 it is still the sheet. Stubbed route (40 files). 1280 and 390, light and
// dark shots. Drives Chrome over CDP against the isolated dev server.
const fs = require('node:fs');
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
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async (name, theme) => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await settle(250); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const geo = () => ev(`(() => { const v = document.getElementById('group-table-view'), p = document.querySelector('.inbox-detail-pane'); if (!p || p.hidden) return null; const vr = v.getBoundingClientRect(), pr = p.getBoundingClientRect(), cs = getComputedStyle(p), main = document.querySelector('.inbox-artifacts-main').getBoundingClientRect(), name = document.querySelector('#group-table-view tbody tr .dt-primary'), // a name's own width: the table folds its columns under the name beside the sidebar
         grip = p.querySelector('.detail-grip');
        return { viewRight: Math.round(vr.left + v.clientWidth), paneRight: Math.round(pr.right), paneW: Math.round(pr.width), paneH: Math.round(pr.height), viewH: v.clientHeight, paneTop: Math.round(pr.top), viewTop: Math.round(vr.top), radius: cs.borderRadius, border: cs.borderTopWidth, mainW: Math.round(main.width), nameW: name ? Math.round(name.getBoundingClientRect().width) : 0, tableW: Math.round((document.querySelector('#group-table-view .dt-box') || document.body).getBoundingClientRect().width), grip: !!grip, gripRole: grip && grip.getAttribute('role'), fixed: cs.position, over: document.documentElement.scrollWidth - innerWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); localStorage.removeItem('coral-detail-width'); ${WORLD}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            if (!mobile) {
                await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]')`, 'the Artifacts folder', 10000);
                await ev(`document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]').click(); true`);
            } else await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('#group-table-view tbody tr').length >= 30`, `${label}: the rows`, 10000);
            await ev(`document.querySelectorAll('#group-table-view tbody .dt-primary')[1].click(); true`);
            await waitFor(`(() => { const p = document.querySelector('.inbox-detail-pane'); return !!p && !p.hidden && /alpha-report/.test(p.textContent); })()`, `${label}: the pane`, 8000);
            await settle(500);
            const g = await geo();
            console.log('DBG', JSON.stringify(g), await ev(`[...document.getElementById('group-table-view').children].map(c => c.className + ' ' + Math.round(c.getBoundingClientRect().top) + ' ' + Math.round(c.getBoundingClientRect().height)).join(' | ')`));
            if (mobile) { check('390: the pane is still the sheet over the page, no sideways scroll', g.fixed === 'fixed' && g.over <= 1, JSON.stringify(g)); await shot('inbox-artifacts-sidebar-390-light', 'light'); await shot('inbox-artifacts-sidebar-390-dark', 'dark'); continue; }
            check('1280: the pane is a sidebar flush to the view\'s right edge, no card (no radius, no outer border)', Math.abs(g.paneRight - g.viewRight) <= 1 && g.radius === '0px' && g.border === '0px', JSON.stringify(g));
            check('1280: it is as tall as the view and starts at its top edge', Math.abs(g.paneH - g.viewH) <= 2 && Math.abs(g.paneTop - g.viewTop) <= 1, `${g.paneH} vs ${g.viewH}, top ${g.paneTop} vs ${g.viewTop}`);
            check('1280: the list keeps its Name column (at least 100 px) beside it', g.nameW >= 100 && g.mainW >= 480, JSON.stringify({ nameW: g.nameW, mainW: g.mainW }));
            check('1280: the grip is a vertical separator on its left edge', g.grip && g.gripRole === 'separator');
            await shot('inbox-artifacts-sidebar-1280-light', 'light'); await shot('inbox-artifacts-sidebar-1280-dark', 'dark');
            // drag the grip 120 px to the left: wider by 120, remembered
            const gr = await ev(`(() => { const r = document.querySelector('.inbox-detail-pane .detail-grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 200) }; })()`);
            const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
            await mouse('mouseMoved', gr.x, gr.y); await mouse('mousePressed', gr.x, gr.y); await mouse('mouseMoved', gr.x + 60, gr.y); await mouse('mouseMoved', gr.x + 120, gr.y); await mouse('mouseReleased', gr.x + 120, gr.y); await settle(300);
            const g2 = await geo();
            check('1280: dragging the grip right 120 px makes the sidebar about 120 px narrower', Math.abs((g.paneW - g2.paneW) - 120) <= 4, `${g.paneW} -> ${g2.paneW}`);
            check('1280: the width is remembered in this browser', Number(await ev(`localStorage.getItem('coral-detail-width')`)) === g2.paneW, String(await ev(`localStorage.getItem('coral-detail-width')`)));
            // far left: the list keeps 560 px
            const gr2 = await ev(`(() => { const r = document.querySelector('.inbox-detail-pane .detail-grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 200) }; })()`);
            await mouse('mousePressed', gr2.x, gr2.y); await mouse('mouseMoved', 200, gr2.y); await mouse('mouseReleased', 200, gr2.y); await settle(300);
            const g3 = await geo();
            check('1280: at its widest the list still has at least 480 px and a readable Name column', g3.mainW >= 476 && g3.nameW >= 100, JSON.stringify({ mainW: g3.mainW, nameW: g3.nameW, paneW: g3.paneW }));
            // the keys and a double click reset
            await ev(`document.querySelector('.inbox-detail-pane .detail-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`); await settle(300);
            const g4 = await geo();
            check('1280: a double click on the grip is back to the default width and forgets the saved one', g4.paneW === g.paneW && (await ev(`localStorage.getItem('coral-detail-width')`)) === null, `${g4.paneW} vs ${g.paneW}`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox Artifacts sidebar checks passed`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
