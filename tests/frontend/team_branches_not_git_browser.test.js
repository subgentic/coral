// The team's Branches tab on folders that are not git repositories (#17483, walk 70 M5): the server says so (not_git) and the tab answers at once with the next step,
// instead of "Reading..." for a minute and then a guess; the text has room to the left. The server's answer is stood in (a real non-git folder is pinned in the Go test); 1680 and 390 px.
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
        safePaused(client, async e => {
            if (new URL(e.request.url).pathname.endsWith('/branches')) await client.Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ available: true, repos: [], not_git: true })).toString('base64') });
            else await client.Fetch.continueRequest({ requestId: e.requestId });
        });
        const board = 'branches-nogit-' + Date.now().toString(36); boards.push(board);
        await Emulation.setDeviceMetricsOverride({ width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator' })).status, 200);
        for (const [w, h, mobile] of [[1680, 1050, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            const t0 = Date.now();
            await Page.navigate({ url: BASE + `/team/${board}/branches` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`/None of this team.s agents works in a git repository/.test((document.getElementById('team-panel-branches') || {}).textContent || '')`, `${w}: the plain answer`, 2000,
                `({ path: location.pathname, panels: [...document.querySelectorAll('[id^=team-panel-]')].map(e => e.id + ':' + e.hidden + ':' + e.textContent.slice(0, 60)) })`);
            const r = await ev(`(() => { const p = document.getElementById('team-panel-branches'), line = p.querySelector('.empty-state, p, div'); const rg = document.createRange(); rg.selectNodeContents(line); const a = p.getBoundingClientRect(), b = rg.getBoundingClientRect(); /* the text itself, not its padded box */ return { text: p.textContent, left: Math.round(b.left - a.left), over: document.documentElement.scrollWidth > innerWidth }; })()`);
            if (r.left < 12 || r.over) throw new Error(`FAILED ${w}px: ${JSON.stringify(r)}`);
            assert.match(r.text, /git init/, `${w}: names the next step`);
            assert.doesNotMatch(r.text, /may not be|Reading/i, `${w}: no guess, no waiting`);
            assert.ok(r.left >= 12, `${w}: the text has room to the left (${r.left} px)`);
            assert.ok(!r.over, `${w}: no sideways scroll`);
            console.log(`${w}: answered in ${Date.now() - t0} ms, left ${r.left}px`);
        }
        console.log('\nPASS the team Branches tab says a non-git folder is not a repository at once');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
