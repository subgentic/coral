// The Inbox's Artifacts folder through a Hub with several computers (#12672, coral-hub's beta pass): one computer failing does not fail the folder (the others are shown, the failing one is named, Retry reads again);
// the count says how many computers it is a sum of, so it does not swing unexplained; a computer on an older Coral that counts every version is named; a read that is not finished or failed never says "No artifacts
// yet". Three linked computers (srv1 answers, srv2 answers slowly, srv3 fails with 500) and the page's own local read answering owner_only. The real page; the routes are stand-ins. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => {
    const real = window.fetch;
    const row = (server, i) => ({ id: server.padEnd(63, 'a').slice(0, 63) + i, name: server + '-report-' + i + '.md', media_type: 'text/markdown', size: 100 + i, created_at: new Date(Date.now() - i * 60000).toISOString(), board_id: 'team', team: 'team', origin: 'agent' });
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.__asked = []; window.__plan = {};
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), m = /^(?:\\/api\\/remote\\/([^/]+))?\\/api\\/team-artifacts$/.exec(url.pathname);
        if (m && (o.method || 'GET').toUpperCase() === 'GET') {
            const server = m[1] || 'local', plan = window.__plan[server] || {};
            window.__asked.push(server + (url.searchParams.has('versions') ? '+v' : ''));
            if (server === 'local') return json({ error: 'owner_only', code: 'owner_only' }, 403);
            const answer = () => {
                if (plan.versionsBad && url.searchParams.has('versions')) return json({ error: 'unknown parameter' }, 400);
                if (plan.status && plan.status !== 200) return json({ error: 'boom' }, plan.status);
                const rows = Array.from({ length: plan.rows || 0 }, (_, i) => row(server, i + 1));
                return json({ artifacts: rows, teams: [], limit: 100, offset: 0, has_more: false, total: rows.length, all: plan.all || rows.length });
            };
            return plan.delay ? new Promise(r => setTimeout(() => r(answer()), plan.delay)) : answer();
        }
        if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const S = `(window.__coralStatic || '/static/')`;
    const status = () => ev(`(document.querySelector('#group-table-view .team-count-line') || {}).textContent || ''`);
    const partial = () => ev(`(document.querySelector('#group-table-view .team-partial-line') || {}).textContent || ''`);
    const rowCount = () => ev(`document.querySelectorAll('#group-table-view tbody tr').length`);
    const open = async (plan, servers, { hubNow = true } = {}) => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${STUB}; window.__plan = ${JSON.stringify(plan)}; true`);
        await ev(`import(${S} + 'state.js').then(m => { m.state.hub = ${hubNow}; m.state.servers = ${JSON.stringify(servers)}; return true; })`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
    };
    const three = [{ id: 'srv1', label: 'Alpha', status: 'online' }, { id: 'srv2', label: 'Beta', status: 'online' }, { id: 'srv3', label: 'Gamma', status: 'online' }];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

        // 1. one computer fails, one is slow: the folder shows the others, names the failing one, and says what the count is a sum of
        await open({ srv1: { rows: 3, all: 500 }, srv2: { rows: 2, all: 113, delay: 1500 }, srv3: { status: 500 } }, three);
        const early = await status();
        check('while a computer is still answering the page says it is loading, never "No artifacts yet"', /Loading artifacts/.test(early) && !/No artifacts yet/.test(early), early);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 5`, 'the rows of the two computers that answered', 15000);
        check('the computers that answered are shown (3 + 2 rows) though one failed', (await rowCount()) === 5, String(await rowCount()));
        const p = await partial();
        check('one quiet line says the count is of 2 of 3 computers and names the one that failed', /613 artifacts from 2 of 3 computers/.test(p) && /Gamma could not be read/.test(p), p);
        check('it has a Retry', await ev(`!!document.querySelector('#group-table-view .team-partial-retry')`));
        check('the line is not an alert (the page keeps quiet)', await ev(`!document.querySelector('#group-table-view .team-partial-line').closest('[role="alert"]') && !document.querySelector('#group-table-view .team-partial-line').getAttribute('role')`));
        // Retry, with the failing computer back: the line goes and its rows join
        await ev(`window.__plan.srv3 = { rows: 4, all: 4 }; document.querySelector('#group-table-view .team-partial-retry').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 9`, 'Retry reads the computer that failed', 15000);
        check('Retry brings the computer that failed back and the partial line goes', (await rowCount()) === 9 && (await partial()) === '', `${await rowCount()} rows, "${await partial()}"`);

        // 2. every computer fails: the failure line (an alert with Retry), not the empty state
        await open({ srv1: { status: 500 }, srv2: { status: 500 }, srv3: { status: 502 } }, three);
        await waitFor(`/could not be read/.test((document.querySelector('#group-table-view .team-count-line') || {}).textContent || '')`, 'the failure line', 15000);
        const failed = await status();
        check('with every computer failing the page says so, not "No artifacts yet"', !/No artifacts yet/.test(failed) && /Alpha, Beta, Gamma|Artifacts could not be read/.test(failed), failed);
        check('and offers Retry', await ev(`!!document.querySelector('#group-table-view .team-artifacts-retry')`));

        // 3. a filter that names a computer that is not online is an empty list, as it always was (it is not "no computer is online": others are)
        await open({}, [{ id: 'srv1', label: 'Alpha', status: 'offline' }, { id: 'srv2', label: 'Beta', status: 'online' }]);
        const none = await ev(`import(${S} + 'inbox_servers.js').then(m => m.readInboxArtifacts(new URLSearchParams(), { server: 'srv1' })).then(d => JSON.stringify({ rows: d.artifacts.length, expected: d.expected, answered: d.answered }), e => 'threw: ' + e.message)`);
        check('a computer filter that names one that is not online gives an empty list, not an error', none === '{"rows":0,"expected":0,"answered":0}', none);

        // 3b. the sidebar's count does not go down on a read some computer did not answer
        await open({ srv1: { rows: 3, all: 500 }, srv2: { rows: 2, all: 113 }, srv3: { rows: 4, all: 4 } }, three);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 9`, 'the whole folder', 15000);
        const full = await ev(`import(${S} + 'inbox_artifacts.js').then(m => m.artifactCount())`);
        check('the folder\'s count is the sum of all three computers', full === 617, String(full));
        await ev(`window.__plan.srv3 = { status: 500 }; const real = Date.now.bind(Date); Date.now = () => real() + 120000; true`); // the count's own freshness window has passed
        const after = await ev(`import(${S} + 'inbox_artifacts.js').then(m => m.refreshArtifactCount().then(() => m.artifactCount()))`);
        check('a read some computer did not answer does not take the count down (it is a sum of the others)', after === 617, String(after));

        // 3c. the first drawing of the list, before its read has started, and the wait for a slow computer, never say "No artifacts yet"
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${STUB}; window.__plan = ${JSON.stringify({ srv1: { rows: 2, all: 2, delay: 1200 }, srv2: { rows: 1, all: 1, delay: 1200 }, srv3: { rows: 1, all: 1, delay: 1200 } })}; true`);
        await ev(`import(${S} + 'state.js').then(m => { m.state.hub = true; m.state.servers = ${JSON.stringify(three)}; return true; })`);
        await ev(`window.__lines = []; new MutationObserver(() => { const t = (document.querySelector('#group-table-view .team-count-line') || {}).textContent; if (t !== undefined && window.__lines[window.__lines.length - 1] !== t) window.__lines.push(t); }).observe(document.body, { subtree: true, childList: true, characterData: true }); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 4`, 'the rows after the slow computers', 15000);
        const lines = await ev(`window.__lines`);
        check('from the first drawing until the rows arrive the status line says loading, never "No artifacts yet"', lines.length > 0 && lines.every(l => !/No artifacts yet/.test(l)) && lines.some(l => /Loading artifacts/.test(l)), JSON.stringify(lines));

        // 4. an older Coral that does not know versions=newest: its count is of every version, and the page says so; the key is read without it there
        await open({ srv1: { rows: 2, all: 20809, versionsBad: true }, srv2: { rows: 1, all: 3 }, srv3: { rows: 1, all: 2 } }, three);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 4`, 'the rows of all three', 15000);
        const v = await partial();
        check('a computer that counts every version is named, and the count is not presented as files alone', /Alpha counts every version of a file, not files/.test(v), v);
        check('it was asked without the key after the 400', (await ev(`window.__asked`)).includes('srv1') && (await ev(`window.__asked`)).includes('srv1+v'), JSON.stringify(await ev(`window.__asked`)));
        check('and no "from N of M computers" for a read every computer answered', !/of 3 computers/.test(v), v);
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Inbox Artifacts computers checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
