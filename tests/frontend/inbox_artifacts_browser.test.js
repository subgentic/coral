// The Inbox's Artifacts folder (Goal #62, #8590): every team's artifacts in one list, the team page's search and Filters with a Team filter and column, and the document in a pane beside the list.
//   - the sidebar has a "Files" section with one folder, Artifacts, and its count (everything the teams hold); the folder opens a page titled Artifacts with the same count;
//   - the rows of two teams are one table, newest first, with a Team column; choosing a team in Filters asks the route for that team (team=...), narrows the rows and takes the column away;
//   - a click on a row opens its document in the pane and the list stays (the rows are still there); another row replaces it; Escape or the close button put it away;
//   - the sidebar's search box is the folder's search (q goes to the route); at 390 px the pane is a sheet with a way back, "<- Artifacts", and the list is under it again after.
// The route is stood in by a fetch wrapper (two teams, five files); the page, the table, the filters and the pane are the real ones, on the isolated dev server. 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SIZING } = require('./helpers/table_sizing');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { ROW_WORDS } = require('./helpers/folder_rows');
const { coralReady } = require('./helpers/wait');

const hex = n => String(n).padStart(64, '0');
const WORLD = `(() => {
    const real = window.fetch; window.__ta = []; window.__star = [];
    const at = m => new Date(Date.now() - m * 60000).toISOString();
    const A = [
        { n: 1, name: 'beta-notes.txt', mt: 'text/plain', board: 'beta', m: 5, task: 12, title: 'Write the notes' },
        { n: 2, name: 'alpha-report.md', mt: 'text/markdown', board: 'alpha', m: 20, task: 7, title: 'Build the report' },
        { n: 3, name: 'beta-data.json', mt: 'application/json', board: 'beta', m: 40, task: 11, title: 'Export the data' },
        { n: 4, name: 'alpha-chart.png', mt: 'image/png', board: 'alpha', m: 60, task: 8, title: 'Draw the chart' },
        { n: 5, name: 'alpha-plan.md', mt: 'text/markdown', board: 'alpha', m: 90, task: 6, title: 'Plan the work' },
    ].map(a => ({ id: String(a.n).padStart(64, '0'), name: a.name, media_type: a.mt, size: 1000 * a.n, created_at: at(a.m), task_id: a.task, task_title: a.title, source: 'task', uri: 'coral://artifacts/' + String(a.n).padStart(64, '0'),
        available: true, inline: false, reference_count: 1, board_id: a.board, team: a.board, starred: a.n === 2 }));
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
        const sr = /^\\/api\\/artifacts\\/([0-9a-f]{64})\\/star$/.exec(p); if (sr && (m === 'PUT' || m === 'DELETE')) { window.__star.push(m + ' ' + sr[1]); return json({ starred: m === 'PUT' }); }
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
    const shot = require('./helpers/scene_shots')(Page); // the gate's uploaded output in CI, CORAL_SCREENSHOT_DIR locally
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => (r.querySelector('.dt-mail-title') || r.querySelector('.dt-primary') || {}).textContent || '')`); // a phone's row is a mail row (#9583): the file's name is its title, the team and task follow it
    const pane = () => ev(`(() => { const p = document.querySelector('.inbox-detail-pane'); return p && !p.hidden ? { title: (p.querySelector('.detail-title') || {}).textContent || '', back: (p.querySelector('.detail-back') || {}).textContent || '', fixed: getComputedStyle(p).position, body: p.textContent } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${WORLD}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            if (!mobile) {
                await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]')`, 'the Artifacts folder in the sidebar', 10000);
                const f = await ev(`(() => { const b = document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]'); let h = b.previousElementSibling; while (h && !h.matches('h2')) h = h.previousElementSibling; return { text: (${ROW_WORDS})(b), section: h ? h.textContent : '' }; })()`);
                check('desktop: the sidebar has a Files section with the Artifacts folder and its count (5)', /Artifacts\s*5/.test(f.text) && f.section === 'Files', JSON.stringify(f));
                await ev(`document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]').click(); true`);
            } else await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('#group-table-view tbody tr').length === 5`, `${label}: five rows`, 10000);
            if (!mobile) { // the table's default sizes (#9856): the artifact's name is at least 24 characters and nothing scrolls sideways, at 1280 and at 1024
                for (const bw of [1280, 1024]) {
                    await Emulation.setDeviceMetricsOverride({ width: bw, height: h, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the table follows its box
                    const z = await ev(SIZING('#group-table-view .dt-box', 'name'));
                    check(`${bw}: the artifact name is at least 24 characters and the table does not scroll sideways`, !!z && !z.scroll && z.name >= z.ch24 - 1, JSON.stringify(z));
                }
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: back to the suite's width
            }
            if (!mobile) check(`${label}: a folder opened by the person puts the keyboard on the page's search box, not on the heading`, (await ev(`document.activeElement && document.activeElement.classList.contains('list-bar-search')`)) && !(await ev(`document.getElementById('group-table-title').matches(':focus, [tabindex]')`)));
            if (mobile) check(`${label}: no second Artifacts heading under the folder button (it names the page and its count), still in the page for a screen reader`, await ev(`(() => { const h = document.getElementById('group-table-title'), b = h && h.parentElement.getBoundingClientRect(), t = document.querySelector('#group-table-view .view-list-trigger'); return !!h && b.width <= 1 && b.height <= 1 && !!t && /Artifacts/.test(t.textContent); })()`));
            check(`${label}: the page is titled Artifacts with the count`, (await ev(`(document.getElementById('group-table-title') || {}).textContent + '|' + (document.querySelector('.inbox-artifacts-count') || {}).textContent`)) === 'Artifacts|5');
            check(`${label}: the rows of both teams are one list, newest first`, (await rows()).join() === 'beta-notes.txt,alpha-report.md,beta-data.json,alpha-chart.png,alpha-plan.md', (await rows()).join());
            // The star on a row (#9834): the filled glyph on a starred row, the empty star only at a hover (a mouse), nothing on touch; the row's name says starred
            const starRow = n => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r => /${n}/.test(r.textContent))`;
            const stars = await ev(`(() => { const st = ${starRow('alpha-report')}, un = ${starRow('beta-notes')}; const f = e => e ? { on: e.classList.contains('dt-star-on'), op: getComputedStyle(e).opacity, shown: getComputedStyle(e).display !== 'none', pe: getComputedStyle(e).pointerEvents } : null; return { starred: f(st.querySelector('.dt-star')), plain: f(un.querySelector('.dt-star')), name: (st.querySelector('.dt-mail-open, .dt-primary') || {}).getAttribute('aria-label') || (st.querySelector('.dt-primary') || {}).textContent }; })()`);
            check(`${label}: a starred row has the filled star, always drawn`, stars.starred && stars.starred.on && stars.starred.shown && stars.starred.op === '1', JSON.stringify(stars));
            if (!mobile) {
                check(`${label}: an unstarred row's star is hidden at rest`, stars.plain && !stars.plain.on && stars.plain.op === '0', JSON.stringify(stars.plain));
                const c = await ev(`(() => { const r = ${starRow('beta-notes')}.getBoundingClientRect(); return [Math.round(r.left + 60), Math.round(r.top + r.height / 2)]; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: c[0], y: c[1] });
                await waitFor(`getComputedStyle(${starRow('beta-notes')}.querySelector('.dt-star')).opacity === '1'`, `${label}: a hovered row shows its empty star`, 4000);
                await ev(`${starRow('beta-notes')}.querySelector('.dt-star').click(); true`);
                await waitFor(`window.__star.length === 1 && ${starRow('beta-notes')}.querySelector('.dt-star').getAttribute('aria-pressed') === 'true'`, `${label}: the star calls PUT and the row is starred`, 4000);
                check(`${label}: the star is PUT on that artifact and named for removing it`, (await ev(`window.__star.join()`)) === 'PUT ' + '0'.repeat(63) + '1' && (await ev(`${starRow('beta-notes')}.querySelector('.dt-star').getAttribute('aria-label')`)) === 'Remove the star from beta-notes.txt', await ev(`window.__star.join()`));
                check(`${label}: the star does not open the row (no pane)`, !(await pane()));
                await ev(`${starRow('beta-notes')}.querySelector('.dt-star').click(); true`);
                await waitFor(`window.__star.length === 2`, `${label}: the second click calls DELETE`, 4000);
                check(`${label}: and it is DELETE`, (await ev(`window.__star[1]`)).startsWith('DELETE '));
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
            } else {
                check(`${label}: on a phone an unstarred row has no star control, and the glyph is not a button`, stars.plain === null || !stars.plain.shown, JSON.stringify(stars)); check(`${label}: the starred row's name says starred, once`, (String(stars.name).match(/starred/g) || []).length === 1, String(stars.name)); check(`${label}: the glyph does not take a tap`, stars.starred.pe === 'none', JSON.stringify(stars.starred));
            }
            check(`${label}: a Team column names each row's team`, (await ev(`[...document.querySelectorAll('#group-table-view thead th')].some(t => /Team/.test(t.textContent)) && /beta/.test(document.querySelector('#group-table-view tbody tr').textContent)`)));
            await shot(`inbox-artifacts-${label}`);

            // the Team filter
            await ev(`(document.querySelector('#group-table-view .list-bar-filter-btn, #group-table-view [aria-controls$="-menu"]') || {}).click?.(); true`);
            await waitFor(`!!document.getElementById('ia-team')`, `${label}: the Team field`, 5000);
            await shot(`inbox-artifacts-${label}-filters`); // the Filters panel open: the fields, Kept only beside its box
            const heights = await ev(`Object.fromEntries(['ia-team', 'ia-by', 'ia-from'].map(id => { const e = document.getElementById(id); return [id, e ? Math.round(e.getBoundingClientRect().height) : -1]; }))`);
            check(`${label}: Uploaded by is a one-line box like Team and From, not a tall empty one`, heights['ia-by'] > 0 && Math.abs(heights['ia-by'] - heights['ia-team']) <= 2 && Math.abs(heights['ia-by'] - heights['ia-from']) <= 2, JSON.stringify(heights)); // a datalist after the input made the panel's column rule miss it, and the panel's 9rem flex basis became its height (#8802)
            const kept = await ev(`(() => { const c = document.getElementById('ia-kept'), l = c && c.closest('label') && c.closest('label').querySelector('.list-bar-field-label'); if (!c || !l) return null; const a = c.getBoundingClientRect(), b = l.getBoundingClientRect(); return { sameRow: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 8, boxFirst: a.right <= b.left + 1, gap: Math.round(b.left - a.right) }; })()`);
            check(`${label}: Kept only has its checkbox beside its label, the box first`, kept && kept.sameRow && kept.boxFirst && kept.gap <= 16, JSON.stringify(kept)); // the column layout of the panel's fields put the box above the words (#8807)
            const target = await ev(`(() => { const c = document.getElementById('ia-kept'), lab = c.closest('label'), w = lab.querySelector('.list-bar-field-label'); const before = c.checked; w.click(); const toggled = c.checked !== before; w.click(); return { toggled, restored: c.checked === before, h: Math.round(lab.getBoundingClientRect().height) }; })()`);
            check(`${label}: the whole label is the click target (a press on its words toggles the box)${mobile ? ', and at least 44 px high' : ''}`, target.toggled && target.restored && (!mobile || target.h >= 44), JSON.stringify(target)); // (#8807, UI/UX)
            // Starred only (#9819): a checkbox beside Kept only that asks the list route for starred=true, and clears again
            check(`${label}: the Filters panel offers Starred only`, !!(await ev(`!!document.getElementById('ia-starred')`)));
            await ev(`document.getElementById('ia-starred').closest('label').querySelector('.list-bar-field-label').click(); true`);
            await waitFor(`window.__ta.some(q => /(^|[?&])starred=true(&|$)/.test(q))`, `${label}: Starred only asks the route for starred=true`, 8000);
            await ev(`document.getElementById('ia-starred').closest('label').querySelector('.list-bar-field-label').click(); true`);
            await ev(`window.__ta.length = 0; true`);
            await ev(`(() => { const s = document.getElementById('ia-team'); s.value = 'beta'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, `${label}: the rows narrowed to the team`, 8000);
            check(`${label}: with Starred only cleared the route is not asked for starred`, !(await ev(`window.__ta.some(q => /starred=/.test(q))`)));
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
