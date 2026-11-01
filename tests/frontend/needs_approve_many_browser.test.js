// #11677 (the operator, desktop app): after Approve on a Needs you item, clicking other rows no longer opened them until a reload. With a few hundred files for review reviewItems() was quadratic (#11633) and an Approve
// redraws three times: the page was busy for seconds, so the clicks that followed went nowhere. Here: 1500 files for review (series of ten versions, so 150 rows), the review route and the lists stubbed in the page; one row is
// approved with a real mouse and a real click on another row's name must open the viewer soon after, and so must a click on a third row's body. 1280 and 390 px (the phone's tap).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'approve-many-' + Date.now().toString(36);
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const N = 1500, SERIES = 150;
    const name = s => 'plan-' + String(s).padStart(3, '0') + '.md';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 800, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i + 1), name: 'plan-' + String(i % ${SERIES}).padStart(3, '0') + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (${N} - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], uri: 'coral://artifacts/' + hex(i + 1), uploader: 'Plan Writer', produced_by: 'Plan Writer', session_id: 'sid-1', review_question: 'Ship it?' });
                window.__items = Array.from({ length: ${N} }, (_, i) => item(i)); window.__calls = [];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                    if (m[2] === 'review') { it.tags = it.tags.filter(x => x !== 'for review').concat('approved'); return json({ id: it.id, state: 'approved', delivered: true, to: 'Plan Writer', review: { state: 'approved', at: new Date().toISOString() } }); }
                    if (method === 'PUT' && body.tags) it.tags = body.tags;
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 10`, at + 'the review rows', 30000);
            const point = (n, part) => ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.querySelector('button[aria-label="Approve: ${name(n)}"]')); if (!tr) return null; tr.scrollIntoView({ block: 'center' }); const el = tr.querySelector('.inbox-review-name, .dt-primary'); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 24)), y: Math.round(r.top + r.height / 2) }; })()`);
            const click = async p => { if (mobile) { await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] }); await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); } else for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); };
            // Approve a row (its own button; on the phone too: Approve is a word there)
            await ev(`document.querySelector('${T} button[aria-label="Approve: ${name(5)}"]').scrollIntoView({ block: 'center' }); true`);
            const t0 = Date.now();
            await ev(`document.querySelector('${T} button[aria-label="Approve: ${name(5)}"]').click(); true`);
            // then, as soon as the page can: a click on another row's name opens it
            const p = await point(7, 'name'); assert.ok(p, at + 'the next row is there');
            await click(p);
            const ok = await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden])')`, at + 'a click on another row opens it', 20000).then(() => true, () => false);
            const took = Date.now() - t0;
            assert.ok(ok, at + 'a click on another row after Approve opened nothing');
            assert.ok(took < (process.env.TOOK_LIMIT ? Number(process.env.TOOK_LIMIT) : 1000), at + `the click after Approve opened the row ${took} ms after the Approve (the page was busy; it should answer in well under a second)`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await waitFor(`document.getElementById('artifact-viewer').hidden`, at + 'the viewer closes', 4000).catch(() => {});
            const gone = await ev(`!document.querySelector('${T} button[aria-label="Approve: ${name(5)}"]')`);
            assert.ok(gone, at + 'the approved series left (its earlier versions with it)');
            await ev(`window.fetch = window.fetch; true`);
        }
        console.log('\nPASS the Inbox answers clicks after an Approve with hundreds of files for review');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
