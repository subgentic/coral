// The self-hosted Hub's Activity folder and Analytics across its computers (#15730, the Operator's two asks): Activity shows every online computer's record merged by time, each row's From names its computer, the
// Computer filter keeps one, and a computer that is offline or refused (an older Coral that does not give its record to a Hub's owner yet) is NAMED as missing, never left out silently. Analytics has a Computer picker
// (this computer plus each linked one) on Usage, Inbox vs chat, Resource queue and the efficiency comparison: the numbers are the picked computer's, read through its own route, and an offline or refusing computer is
// said plainly. The real page; the routes are stand-ins (the Go suite proves the Hub signs the owner's reads). Four linked computers: srv1 and srv2 answer, srv3 is offline, srv4 refuses (403). 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const sceneShots = require('./helpers/scene_shots');

const ONE_DAY = 86400000;
const TODAY = new Date().toISOString().slice(0, 10);
const STUB = `(() => {
    const real = window.fetch;
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    const act = (server, i, minsAgo, title) => ({ id: i, at: new Date(Date.now() - minsAgo * 60000).toISOString(), action: 'approve', item_kind: 'file', item_id: server + i, title, team: 'team', source: 'local', actor: 'local' });
    const bucket = (cost) => Array.from({ length: 28 }, (_, i) => { const d = new Date(Date.parse('${TODAY}T00:00:00Z') - (27 - i) * ${ONE_DAY}).toISOString().slice(0, 10); return { bucket: d + 'T00:00:00Z', cost_usd: cost, input_tokens: 1000, output_tokens: 500, num_requests: 2, cache_read_tokens: 0, series: [{ key: 'agent-' + cost, label: 'Agent ' + cost, cost_usd: cost, input_tokens: 1000, output_tokens: 500, num_requests: 2 }] }; });
    const COST = { local: 1, srv1: 5, srv2: 9 };
    window.__asked = [];
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), m = /^(?:\\/api\\/remote\\/([^/]+))?(\\/api\\/.*)$/.exec(url.pathname);
        if (!m || (o.method || 'GET').toUpperCase() !== 'GET') return real(u, o);
        const server = m[1] || 'local', p = m[2];
        if (p === '/api/activity') {
            window.__asked.push(server + p);
            if (server === 'srv4') return json({ error: 'owner_only', code: 'owner_only' }, 403);
            const rows = { local: [act('local', 1, 5, 'Hub note')], srv1: [act('srv1', 1, 2, 'Alpha report'), act('srv1', 2, 30, 'Alpha plan')], srv2: [act('srv2', 1, 10, 'Beta report')] }[server] || [];
            return json({ actions: rows, check: { intact: true, rows: rows.length, note: '' }, more: false });
        }
        if (p === '/api/token-usage/timeseries' && url.searchParams.get('interval') === '1d') { window.__asked.push(server + p); return json({ interval: '1d', buckets: bucket(COST[server] || 1) }); }
        if (p === '/api/analytics/inbox-vs-chat') { window.__asked.push(server + p); return server === 'srv4' ? json({ error: 'owner_only' }, 403) : json({ days: [], teams: [], totals: {} }); }
        if (p === '/api/analytics/resource-queue') { window.__asked.push(server + p); return json({ error: 'owner_only' }, 403); }
        if (p === '/api/board/projects') return json([]);
        return real(u, o);
    };
    return true; })()`;
const SERVERS = [{ id: 'srv1', label: 'Alpha', status: 'online' }, { id: 'srv2', label: 'Beta', status: 'online' }, { id: 'srv3', label: 'Gamma', status: 'offline' }, { id: 'srv4', label: 'Delta', status: 'online' }];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const shot = sceneShots(Page, 'hub-activity-analytics');
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const S = `(window.__coralStatic || '/static/')`;
    const start = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-inbox-activity-filters'); ${STUB}; true`);
        await ev(`import(${S} + 'state.js').then(m => { m.state.hub = true; m.state.servers = ${JSON.stringify(SERVERS)}; return true; })`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

        // ---- Activity
        await start();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('activity')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 4 || /Not in this list|could not be read/.test(document.body.innerText)`, 'the Activity rows', 15000);
        const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim())`);
        const got = await rows();
        check('every online computer\'s record is in the folder, newest first (Alpha 2 min, this computer 5, Beta 10, Alpha 30)', got.length === 4 && /Alpha report/.test(got[0]) && /Hub note/.test(got[1]) && /Beta report/.test(got[2]) && /Alpha plan/.test(got[3]), JSON.stringify(got));
        check('each row\'s From names its computer', /Alpha/.test(got[0]) && /This computer/.test(got[1]) && /Beta/.test(got[2]) && /Alpha/.test(got[3]), JSON.stringify(got));
        const gaps = await ev(`(document.querySelector('.activity-check') || {}).textContent || ''`);
        check('the computers that are not in the list are named with why: Gamma offline, Delta refused', /Gamma \(is offline\)/.test(gaps) && /Delta \(refused to give its record/.test(gaps), gaps);
        check('the offline computer is not asked, the refusing one is', !(await ev(`window.__asked`)).includes('srv3/api/activity') && (await ev(`window.__asked`)).includes('srv4/api/activity'), JSON.stringify(await ev(`window.__asked`)));
        await shot('activity-merged');
        // the Computer filter keeps one computer's rows
        const filterId = await ev(`(() => { const s = [...document.querySelectorAll('select')].find(x => /server/.test(x.id) && x.closest('.inbox-folder-toolbar')); return s ? s.id : ''; })()`);
        check('the Computer filter is on the Activity toolbar', !!filterId, filterId);
        if (filterId) {
            await ev(`(() => { const s = document.getElementById(${JSON.stringify(filterId)}); s.value = 'srv1'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'only Alpha\'s rows', 8000);
            const only = await rows();
            check('choosing Alpha keeps its two rows and no other computer\'s', only.length === 2 && only.every(r => /Alpha/.test(r)), JSON.stringify(only));
            await shot('activity-filtered-to-one-computer');
        }

        // ---- Analytics
        await start();
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 4`, 'the Analytics views', 10000);
        const open = key => ev(`import(${S} + 'analytics_views.js').then(m => { m.selectView(${JSON.stringify(key)}); return true; })`);
        const pick = async id => { await ev(`(() => { const s = [...document.querySelectorAll('.atab select[aria-label="Computer"]')].find(e => e.offsetParent); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
        const spend = () => ev(`(document.querySelector('.atab-kpi') || {}).innerText || ''`);
        await open('usage');
        await waitFor(`document.querySelectorAll('.atab-kpi').length >= 6`, 'Usage drawn', 10000);
        const choices = await ev(`[...document.querySelectorAll('.atab select[aria-label="Computer"] option')].map(o => o.textContent)`);
        check('Usage has a Computer picker: this computer and each linked one, the offline one marked', JSON.stringify(choices) === JSON.stringify(['This computer', 'Alpha', 'Beta', 'Gamma (offline)', 'Delta']), JSON.stringify(choices));
        const first = await spend();
        await shot('analytics-usage-this-computer');
        await pick('srv2');
        await waitFor(`(window.__asked || []).includes('srv2/api/token-usage/timeseries')`, 'Beta\'s own read', 8000);
        await waitFor(`/126/.test((document.querySelector('.atab-kpi') || {}).innerText || '')`, 'Beta\'s spend', 8000);
        check('picking Beta reads Beta\'s own route and shows Beta\'s numbers, not this computer\'s', (await spend()) !== first && /\$126/.test(await spend()), `${first.replace(/\\s+/g, ' ')} -> ${(await spend()).replace(/\\s+/g, ' ')}`);
        await shot('analytics-usage-picked-computer');
        await pick('srv3');
        await waitFor(`/is offline/.test((document.querySelector('.atab') || {}).innerText || '')`, 'the offline line', 8000);
        check('an offline computer is said plainly, not drawn as zero', /Gamma is offline, so its numbers cannot be read/.test(await ev(`document.querySelector('.atab').innerText`)), await ev(`document.querySelector('.atab').innerText.slice(0, 160)`));
        check('and it was not asked', !(await ev(`window.__asked`)).some(a => a.startsWith('srv3/')));
        await shot('analytics-offline-computer');
        // a computer that refuses the person-only reads (Inbox vs chat): said plainly, with why
        await open('inbox-chat');
        await waitFor(`[...document.querySelectorAll('.atab select[aria-label="Computer"]')].some(e => e.offsetParent)`, 'Inbox vs chat drawn', 8000);
        await pick('srv4');
        const here = `([...document.querySelectorAll('.atab')].find(e => e.offsetParent) || {}).innerText || ''`;
        await waitFor(`/would not give these numbers/.test(${here})`, 'the refusal line', 8000);
        check('a computer that refuses is named, with the likely reason, on Inbox vs chat', /Delta would not give these numbers\. It may be an older Coral that needs an update/.test(await ev(here)), (await ev(here)).slice(0, 200));
        await shot('analytics-refusing-computer');
        // this computer again: the page is as it always was
        await pick('local');
        await waitFor(`(window.__asked || []).filter(a => a === 'local/api/analytics/inbox-vs-chat').length >= 1`, 'this computer\'s own read', 8000);
        check('this computer is read through the plain route again', true);
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Hub Activity and Analytics computers checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
