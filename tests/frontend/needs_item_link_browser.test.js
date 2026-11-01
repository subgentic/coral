// A link to ONE item of Needs you (#11797): /inbox/needs/review/[@<server>/]<team>/<file id> and /inbox/needs/ask/[@<server>/]<team>/<question id>, the address a push notification opens (coral-hub's Web Push, #11785's Coral dot).
// Opened as the page's own address (a fresh load), the Inbox is on Needs you and the item is on its own card: the file in the viewer with Approve and Request changes ready, the question in its dialog with the Reply box. A file that
// was already decided says so ("it was approved"), a file or a question that is not there says so, a malformed address is not a route, and the address builds back to itself (a remote computer's @server and an encoded team name). 1280 and 390.
// The board's artifacts and the Operator's questions are stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

const hex = n => n.toString(16).padStart(64, '0');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'link-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // what the page answers for the board and the Operator's questions, from the first request of every load of this page
    const STUB = `(() => { const real = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })), at = new Date(Date.now() - 600000).toISOString();
        const art = (n, tags) => ({ id: '${hex(0)}'.slice(0, 63) + n, name: 'plan-' + n + '.md', media_type: 'text/markdown', size: 30, created_at: at, source: 'upload', available: true, tags, produced_by: 'Orchestrator' });
        const lists = { 'for review': [art(1, ['for review'])], approved: [art(2, ['approved'])], reviewed: [] };
        window.fetch = (url, opts = {}) => { const u = new URL(String(url && url.url || url), location.origin), m = (opts.method || 'GET').toUpperCase();
            if (m === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: lists[u.searchParams.get('tag')] || [], has_more: false });
            if (m === 'GET' && u.pathname === '/api/operator-asks') return json([{ board: '${team}', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: at }]);
            if (m === 'GET' && /^\\/api\\/artifacts\\/[0-9a-f]{64}$/.test(u.pathname)) return Promise.resolve(new Response('# Plan', { status: 200, headers: { 'content-type': 'text/markdown' } }));
            if (/^\\/api\\/artifacts\\/[0-9a-f]{64}\\/(versions|meta|readers|comments)/.test(u.pathname)) return Promise.resolve(new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
            return real(url, opts); }; })();`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        // the address and the route are one thing both ways
        const rt = await ev(`import(${S} + 'routes.js').then(m => { const p = '/inbox/needs/review/@m2/' + encodeURIComponent('My team') + '/${hex(255)}', r = m.parse(p), a = m.parse('/inbox/needs/ask/${team}/41'); return { r, back: m.build(r), a, backAsk: m.build(a), bad: ['/inbox/needs/review/${team}/zzz', '/inbox/needs/review/${team}', '/inbox/needs/ask/${team}/0', '/inbox/needs/other/${team}/41', '/inbox/needs/review/@/${team}/${hex(1)}'].map(x => m.parse(x)) }; })`);
        check(rt.r && rt.r.need && rt.r.need.kind === 'review' && rt.r.need.server === 'm2' && rt.r.need.team === 'My team' && rt.back === `/inbox/needs/review/@m2/My%20team/${hex(255)}`, 'a file on another computer parses and builds back: ' + JSON.stringify([rt.r, rt.back]));
        check(rt.a && rt.a.need && rt.a.need.kind === 'ask' && rt.backAsk === `/inbox/needs/ask/${team}/41`, 'a question parses and builds back: ' + JSON.stringify([rt.a, rt.backAsk]));
        check(rt.bad.every(x => x === null), 'a malformed address is not a route: ' + JSON.stringify(rt.bad));
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            const open = async path => { await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
            const toast = txt => waitFor(`[...document.querySelectorAll('.toast')].some(t => /${txt}/.test(t.textContent))`, at + `a toast says ${txt}`, 10000);
            // a file waiting for review: the viewer, on its card, with the decisions ready
            await open(`/inbox/needs/review/${team}/${hex(0).slice(0, 63)}1`);
            await waitFor(`!!document.querySelector('.artifact-viewer')`, at + 'the file opens in the viewer', 12000);
            const v = await ev(`(() => { const btn = t => [...document.querySelectorAll('.artifact-viewer button')].find(b => b.textContent.trim() === t); return { title: (document.querySelector('.artifact-viewer h2, .artifact-viewer .artifact-viewer-title') || {}).textContent, approve: !!btn('Approve') && !btn('Approve').disabled, changes: !!btn('Request changes') && !btn('Request changes').disabled, path: location.pathname }; })()`);
            check(v.approve && v.changes, at + 'Approve and Request changes are ready: ' + JSON.stringify(v));
            check(/plan-1\.md/.test(String(v.title)), at + 'it is the file the link names: ' + JSON.stringify(v));
            await shot(`needs-item-link-review-${w}`);
            // already decided
            await open(`/inbox/needs/review/${team}/${hex(0).slice(0, 63)}2`);
            await toast('That file is not waiting for you any more');
            check(await ev(`!document.querySelector('.artifact-viewer')`), at + 'a decided file opens no viewer');
            // not there
            await open(`/inbox/needs/review/${team}/${hex(0).slice(0, 63)}9`);
            await toast('That file is not waiting for you any more');
            // a question: its dialog with a Reply box
            await open(`/inbox/needs/ask/${team}/41`);
            await waitFor(`!!document.querySelector('dialog[open] textarea')`, at + 'the question opens with its Reply box', 12000);
            check(await ev(`/Which port should the test server use\\?/.test(document.querySelector('dialog[open]').textContent)`), at + 'it is the question the link names');
            await shot(`needs-item-link-ask-${w}`);
            await open(`/inbox/needs/ask/${team}/99`);
            await toast('That question is not waiting for you any more');
            // not a route: nothing opens, the page is the start
            await open(`/inbox/needs/review/${team}/zzz`);
            check(await ev(`!document.querySelector('.artifact-viewer') && !document.querySelector('dialog[open]')`), at + 'a malformed link opens nothing');
        }
        await removeBoards(ev, [team]).catch(() => {});
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_item_link_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
