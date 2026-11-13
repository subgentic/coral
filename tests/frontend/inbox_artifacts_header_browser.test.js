// The Inbox Artifacts page has the header every other list has (design guidelines 4.2, #15834): row 1 is the title with its grey count, row 2 is the search and the filter icon (the old page put the search above
// the title). While the list is read, "Loading artifacts…" sits where the table will be, under the header. 1440 and 390 px, dark and light, 200% text; nothing is cut or wider than the page.
// The route is stood in by a fetch wrapper (one team, three files); the first answer is held until the test lets it go, so the loading line can be measured.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const WORLD = `(() => {
    const real = window.fetch; window.__hold = true; window.__release = null;
    const at = m => new Date(Date.now() - m * 60000).toISOString();
    const A = [1, 2, 3].map(n => ({ id: String(n).padStart(64, '0'), name: 'file-' + n + '.md', media_type: 'text/markdown', size: 1000 * n, created_at: at(n * 10), task_id: n, task_title: 'Task ' + n, source: 'task', uri: 'coral://artifacts/' + String(n).padStart(64, '0'),
        available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha', starred: false }));
    const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), p = url.pathname;
        if (p === '/api/team-artifacts') {
            const body = { artifacts: A, limit: 100, offset: 0, has_more: false, truncated: false, total: 3, all: 3, teams: [{ board_id: 'alpha', team: 'alpha', all: 3 }] };
            return window.__hold ? new Promise(res => { window.__release = () => res(json(body)); }) : json(body);
        }
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const measure = () => ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), cy: Math.round((b.top + b.bottom) / 2) }; };
        const view = document.getElementById('group-table-view'), row = view.querySelector('.list-bar-search-row'), q = s => row && row.querySelector(s);
        const h2 = q('#group-table-title'), cnt = q('.session-group-count'), search = q('.list-bar-search-wrap, .list-bar-search'), filt = q('.list-bar-toggle, .list-bar-more');
        const old = view.querySelectorAll('.inbox-artifacts-main > .group-table-head, .inbox-artifacts-count').length;
        const load = [...view.querySelectorAll('*')].find(e => !e.children.length && /^Loading artifacts/.test(e.textContent.trim()));
        return { h2: h2 && r(h2), cnt: cnt && r(cnt), cntText: cnt && cnt.textContent, cntColor: cnt && getComputedStyle(cnt).color, textColor: h2 && getComputedStyle(h2).color, search: search && r(search), filt: filt && r(filt), old, load: load && r(load), row: row && r(row),
            tableTop: (view.querySelector('.dt-box, table, .vl-panel') || { getBoundingClientRect: () => ({ top: -1 }) }).getBoundingClientRect().top, viewScroll: view.scrollWidth, viewClient: view.clientWidth,
            outside: row ? [...row.querySelectorAll('.inbox-folder-head, .list-bar-search-wrap, .list-bar-toggle, .list-bar-more')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1)).map(e => e.className) : ['no row'] }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const modes = [['1440 px dark', 1440, 900, false, 'dark', ''], ['1440 px light', 1440, 900, false, 'light', ''], ['390 px dark', 390, 844, true, 'dark', ''], ['390 px light', 390, 844, true, 'light', ''], ['1440 px 200% text', 1440, 900, false, 'dark', '200%'], ['390 px 200% text', 390, 844, true, 'dark', '200%']];
        for (const [label, w, h, mobile, theme, zoom] of modes) {
            const at = label + ': ';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; ${WORLD}`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .list-bar-search-row #group-table-title') && !!document.querySelector('#group-table-view .list-bar-search-wrap, #group-table-view .list-bar-search')`, `${at}the header is drawn`, 10000);
            await waitFor(`[...document.querySelectorAll('#group-table-view *')].some(e => !e.children.length && /^Loading artifacts/.test(e.textContent.trim()))`, `${at}the loading line shows while the list is read`, 8000);
            await ev(`new Promise(r => setTimeout(r, 400)).then(() => true)`); // sleep-ok: the header settles before it is measured
            const L = await measure();
            check(L.load && L.search && L.load.t >= L.search.b - 1, `${at}"Loading artifacts…" is under the header, where the table will be: ${JSON.stringify([L.search, L.load])}`);
            await ev(`window.__hold = false; window.__release && window.__release(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, `${at}three rows`, 10000);
            await ev(`new Promise(r => setTimeout(r, 600)).then(() => true)`); // sleep-ok: late redraws finish before the boxes are read
            const m = await measure();
            check(m.old === 0, `${at}the page's own head and count are gone (${m.old})`);
            check(m.h2 && m.cnt && m.cntText === '3', `${at}row 1 has the title and its count of 3 (${m.cntText})`);
            check(m.cnt && m.cntColor !== m.textColor, `${at}the count is grey, not the title's colour`);
            if (m.h2 && m.cnt && m.search && m.filt) {
                check(Math.abs(m.h2.cy - m.cnt.cy) <= 10 && m.h2.r <= m.cnt.l + 1, `${at}the count follows the title on one line: ${JSON.stringify([m.h2, m.cnt])}`);
                check(m.search.t >= m.h2.b - 1 && m.search.t >= m.cnt.b - 1, `${at}the search is under the title, not above it: ${JSON.stringify([m.h2, m.search])}`);
                check(zoom && w < 768 ? m.filt.t >= m.search.t : (m.filt.t < m.search.b && m.filt.l >= m.search.r - 1), `${at}the filter icon is on the search's row, after it (at 200% on a phone it may wrap under it): ${JSON.stringify([m.search, m.filt])}`);
            } else check(false, `${at}the header parts are missing: ${JSON.stringify(m)}`);
            check(m.outside.length === 0 && m.viewScroll <= m.viewClient + 1, `${at}nothing is cut or wider than the page (${JSON.stringify(m.outside)}, ${m.viewScroll} of ${m.viewClient})`);
            if (['1440 px dark', '1440 px light', '390 px dark', '390 px light', '390 px 200% text'].includes(label)) await shot('artifacts-header-' + label.replace(/ /g, '-'));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'The Artifacts header:\n  ' + problems.join('\n  '));
    console.log('PASS the Artifacts page: title and count in row 1, search and filter icon in row 2, the loading line under them');
})().catch(e => { console.error(e); process.exit(1); });
