// A branch row opens (#17543, walk 77 H1/L17): the row's button shows the commits the branch has over the base and the files they change, read when it is pressed, and the row names its agents
// by what the server calls them. The server's answers are stood in (the real git reads are pinned in the Go tests); 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await client.Fetch.enable({ patterns: [{ urlPattern: '*/branches*' }] });
        const seen = [];
        const repo = { base: 'main', more: 0, at: new Date().toISOString(), remote_unknown: false, ask: { name: 'beta77-repo', session_id: 'sess-1', agent_type: 'claude' },
            worktrees: [{ branch: 'main', head: 'aaaaaaaaaaaa', ahead: 0, behind: 0, changed: 0, untracked: 0, main: true }, { branch: 'feature/stopwatch', head: 'bbbbbbbbbbbb', ahead: 1, behind: 0, changed: 0, untracked: 0, agents: [{ name: 'Developer 2', session_id: 'sess-1', agent_type: 'claude' }] }] };
        safePaused(client, async e => {
            const path = new URL(e.request.url).pathname;
            const json = (code, o) => client.Fetch.fulfillRequest({ requestId: e.requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(o)).toString('base64') });
            if (path.endsWith('/branches/detail')) { seen.push(new URL(e.request.url).searchParams.get('head')); await json(200, { base: 'main', commits: [{ id: 'bbbbbbbbbbbb', author: 'rich', at: '2026-11-14T10:00:00Z', subject: 'Add the stopwatch' }], files: [{ path: 'stopwatch.html', added: 40, removed: 2 }] }); }
            else if (path.endsWith('/branches')) await json(200, { available: true, repos: [repo] });
            else await client.Fetch.continueRequest({ requestId: e.requestId });
        });
        const board = 'branches-detail-' + Date.now().toString(36); boards.push(board);
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' })).status, 200);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            seen.length = 0;
            await Page.navigate({ url: BASE + `/team/${board}/branches` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`document.querySelectorAll('#team-panel-branches .branches-row').length === 2`, `${w}: the rows`, 4000);
            const rowText = await ev(`document.querySelectorAll('#team-panel-branches .branches-row')[1].textContent`);
            assert.match(rowText, /Agents: Developer 2/, `${w}: the row names its agent`);
            assert.ok(await ev(`!document.querySelector('#team-panel-branches .branches-row .branches-detail-body:not([hidden])')`), `${w}: closed until pressed`);
            await ev(`document.querySelectorAll('#team-panel-branches .branches-row')[1].querySelector('.branches-more').click(); true`);
            await waitFor(`/Add the stopwatch/.test(document.getElementById('team-panel-branches').textContent)`, `${w}: the commit is listed`, 4000);
            const t = await ev(`document.querySelectorAll('#team-panel-branches .branches-row')[1].querySelector('.branches-detail-body').textContent`);
            assert.match(t, /1 commit over main/); assert.match(t, /stopwatch\.html/); assert.match(t, /\+40 .2/);
            assert.deepEqual(seen, ['bbbbbbbbbbbb'], `${w}: asked once for that branch's head`);
            assert.equal(await ev(`document.querySelectorAll('#team-panel-branches .branches-row')[1].querySelector('.branches-more').getAttribute('aria-expanded')`), 'true');
            assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), `${w}: no sideways scroll`);
        }
        console.log('\nPASS a branch row opens to its commits and files');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
