// The Inbox's Artifacts folder (Goal #62, #8590): every team's artifacts in one list, the team page's search and Filters with a Team filter and column, and the document in a pane beside the list.
//   - the sidebar has a "Files" section with one folder, Artifacts, and its count (everything the teams hold); the folder opens a page titled Artifacts with the same count;
//   - the rows of two teams are one table, newest first, with a Team column; choosing a team in Filters asks the route for that team (team=...), narrows the rows and takes the column away;
//   - a click on a row opens its document in the pane and the list stays (the rows are still there); another row replaces it; Escape or the close button put it away;
//   - the sidebar's search box is the folder's search (q goes to the route); at 390 px the pane is a sheet with a way back, "<- Artifacts", and the list is under it again after.
// The route is stood in by a fetch wrapper (two teams, five files); the page, the table, the filters and the pane are the real ones, on the isolated dev server. 1280 and 390 px.
const assert = require('node:assert/strict');
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
    ].map(a => ({ id: String(a.n).padStart(64, '0'), name: a.name, media_type: a.mt, size: 1000 * a.n, created_at: at(a.m), task_id: a.task, task_title: a.title, source: 'task', uri: 'coral://artifacts/' + String(a.n).padStart(64, '0'),
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
                teams: [{ board_id: 'alpha', team: 'alpha', all: 3 }, { board_id: 'beta', team: 'beta', all: 2 }] });
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
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => (r.querySelector('.dt-primary') || {}).textContent || '')`);
    const pane = () => ev(`(() => { const p = document.querySelector('.inbox-detail-pane'); return p && !p.hidden ? { title: (p.querySelector('.detail-title') || {}).textContent || '', back: (p.querySelector('.detail-back') || {}).textContent || '', fixed: getComputedStyle(p).position, body: p.textContent } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${WORLD}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            if (!mobile) {
                await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]')`, 'the Artifacts folder in the sidebar', 10000);
                const f = await ev(`(() => { const b = document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]'); let h = b.previousElementSibling; while (h && !h.matches('h2')) h = h.previousElementSibling; return { text: b.textContent.replace(/\\s+/g, ' ').trim(), section: h ? h.textContent : '' }; })()`);
                check('desktop: the sidebar has a Files section with the Artifacts folder and its count (5)', /Artifacts\s*5/.test(f.text) && f.section === 'Files', JSON.stringify(f));
                await ev(`document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]').click(); true`);
            } else await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('#group-table-view tbody tr').length === 5`, `${label}: five rows`, 10000);
            if (!mobile) check(`${label}: a folder opened by the person puts the keyboard on the page's search box, not on the heading`, (await ev(`document.activeElement && document.activeElement.classList.contains('list-bar-search')`)) && !(await ev(`document.getElementById('group-table-title').matches(':focus, [tabindex]')`)));
            check(`${label}: the page is titled Artifacts with the count`, (await ev(`(document.getElementById('group-table-title') || {}).textContent + '|' + (document.querySelector('.inbox-artifacts-count') || {}).textContent`)) === 'Artifacts|5');
            check(`${label}: the rows of both teams are one list, newest first`, (await rows()).join() === 'beta-notes.txt,alpha-report.md,beta-data.json,alpha-chart.png,alpha-plan.md', (await rows()).join());
            check(`${label}: a Team column names each row's team`, (await ev(`[...document.querySelectorAll('#group-table-view thead th')].some(t => /Team/.test(t.textContent)) && /beta/.test(document.querySelector('#group-table-view tbody tr').textContent)`)));
            await shot(`inbox-artifacts-${label}`);

            // the Team filter
            await ev(`(document.querySelector('#group-table-view .list-bar-filter-btn, #group-table-view [aria-controls$="-menu"]') || {}).click?.(); true`);
            await waitFor(`!!document.getElementById('ia-team')`, `${label}: the Team field`, 5000);
            await ev(`(() => { const s = document.getElementById('ia-team'); s.value = 'beta'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, `${label}: the rows narrowed to the team`, 8000);
            check(`${label}: the Team filter asks the route for that team`, (await ev(`window.__ta.some(q => /(^|[?&])team=beta(&|$)/.test(q))`)));
            check(`${label}: with one team chosen the Team column goes`, !(await ev(`[...document.querySelectorAll('#group-table-view thead th')].some(t => /^Team$/.test(t.textContent.trim()))`)));
            await ev(`(() => { const s = document.getElementById('ia-team'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 5`, `${label}: all rows again`, 8000);

            // a row opens its document beside the list
            await ev(`document.querySelectorAll('#group-table-view tbody .dt-primary')[1].click(); true`);
            await waitFor(`(() => { const p = document.querySelector('.inbox-detail-pane'); return !!p && !p.hidden && /alpha-report/.test(p.textContent); })()`, `${label}: the pane with the document`, 8000);
            let p = await pane();
            check(`${label}: the pane takes the keyboard on its close button, and its title has no focus to draw a ring round`, (await ev(`document.activeElement && document.activeElement.classList.contains('detail-close')`)) && !(await ev(`document.querySelector('.inbox-detail-pane .detail-title').matches(':focus')`)));
            check(`${label}: the row opened its document in the pane`, p && /alpha-report\.md/.test(p.title), JSON.stringify(p && p.title));
            check(`${label}: the list stays (five rows) with the pane open`, (await rows()).length === 5);
            if (mobile) check('390: the pane is a sheet with a way back named Artifacts', p.fixed === 'fixed' && /Artifacts/.test(p.back), JSON.stringify(p));
            else check('1280: the pane sits beside the list, not over it', p.fixed !== 'fixed', p.fixed);
            await shot(`inbox-artifacts-${label}-open`);
            if (!mobile) { // another row replaces it
                await ev(`document.querySelectorAll('#group-table-view tbody .dt-primary')[2].click(); true`);
                await waitFor(`/beta-data/.test((document.querySelector('.inbox-detail-pane .detail-title') || {}).textContent || '')`, 'the second document replaces the first', 8000);
                check('1280: another row replaces the document, one click each', true);
            }
            await ev(`document.querySelector('.inbox-detail-pane .detail-close, .inbox-detail-pane .detail-back').click(); true`);
            await waitFor(`document.querySelector('.inbox-detail-pane').hidden`, `${label}: the pane closes`, 5000);
            check(`${label}: the close puts the pane away and the list is still there`, (await rows()).length === 5);

            // the sidebar's search is the folder's
            if (!mobile) {
                await ev(`(() => { const i = document.getElementById('inbox-search'); i.value = 'chart'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, 'the search narrowed the list', 8000);
                check('1280: the sidebar search box searches the folder (q goes to the route)', (await ev(`window.__ta.some(q => /(^|[?&])q=chart(&|$)/.test(q))`)));
            }
            check(`${label}: nothing runs past the page edge`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})().catch(e => { console.error(e); process.exitCode = 1; });
