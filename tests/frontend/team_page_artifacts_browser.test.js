// The team page's Artifacts tab carries what the old dock tab had (#7453, stage 3 of the inventory): the search box and Filters and Sort bar (the query is the server's: q, kind, sort), the origin badges ("From <computer>", "Link not verified" with no type or size),
// every detail of the old row in the pane (received-from and "Not scanned" for a received file), Refresh, Keep (a toggle that sends PUT and DELETE /api/artifacts/<id>/keep) and Delete (a confirmation, then DELETE and the row is gone, the focus on the next row).
// The board's artifact list and the keep and delete routes are stubbed in the page. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-art-${Date.now() % 100000}`;
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); window.__req = []; window.__kept = [];
        const ALL = [
          { id: '${A}', name: 'Settings audit', media_type: 'text/markdown', size: 4200, task_id: 12, task_title: 'Audit settings', created_at: '2026-10-25T06:00:00Z', uri: 'coral://artifacts/${A}', available: true, produced_by: 'QA Engineer', source: 'uploaded' },
          { id: '${B}', name: 'build-log.txt', media_type: 'text/plain', size: 900, task_id: 0, created_at: '2026-10-24T06:00:00Z', uri: 'coral://artifacts/${B}', available: true, source: 'received', received_from: 'build-server', from_board: 'ci', sent_by: 'Bot' },
          { id: '${C}', name: 'ghost.md', media_type: '', size: null, task_id: 0, created_at: '2026-10-23T06:00:00Z', uri: 'coral://artifacts/${C}', available: false, provenance: 'unverified', source: 'uploaded' }];
        const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = (o.method || 'GET').toUpperCase();
            if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) { window.__req.push(url.search); const q = (url.searchParams.get('q') || '').toLowerCase(); const rows = ALL.filter(a => !q || a.name.toLowerCase().includes(q)); return j({ project: ${JSON.stringify(TEAM)}, artifacts: rows, has_more: false, total: rows.length, all: ALL.length }); }
            if (url.pathname === '/api/system/artifact-store/kept') return j({ kept: [] });
            if (/^\\/api\\/artifacts\\/[a-f0-9]{64}\\/keep$/.test(url.pathname)) { window.__kept.push(m); return j({ ok: true }); }
            if (/^\\/api\\/artifacts\\/[a-f0-9]{64}$/.test(url.pathname) && m === 'DELETE') { window.__deleted = url.pathname; return j({ ok: true }); }
            if (/^\\/api\\/artifacts\\/[a-f0-9]{64}$/.test(url.pathname)) return Promise.resolve(new Response('# Settings audit\\n\\nBody.', { headers: { 'Content-Type': 'text/markdown' } }));
            return R(u, o); }; return true; })()`);
    const rows = () => ev(`[...document.querySelectorAll('#team-panel-artifacts tbody tr')].map(r => window.__na.text(r))`);
    const click = (sel, rx) => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(window.__na.vis).find(x => ${rx}.test(window.__na.name(x))); if (!e) return false; e.click(); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); await stub(); await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Artifacts'); await settle(600);
        await S.run('the search, Filters and Sort bar is there and a search asks the server (q) and says so in a chip', async () => {
            assert.ok(await ev(`!!document.querySelector('#team-panel-artifacts input[type=search], #team-panel-artifacts input[aria-label="Search team artifacts"]')`), 'a search box named Search team artifacts');
            await ev(`(() => { const i = document.querySelector('#team-panel-artifacts input[aria-label="Search team artifacts"]'); i.value = 'audit'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`); await settle(600); // Enter asks at once (typing asks after a pause)
            const reqs = await ev(`window.__req`); assert.ok(reqs.some(s => /q=audit/.test(s) && /sort=newest/.test(s)), `the request carries q and sort: ${JSON.stringify(reqs)}`);
            assert.equal((await rows()).length, 1, 'one artifact matches');
            assert.ok(await ev(`!![...document.querySelectorAll('#team-panel-artifacts .list-bar-chip')].find(c => /Search: audit/.test(c.textContent))`), 'a chip says Search: audit');
            await ev(`(() => { const i = document.querySelector('#team-panel-artifacts input[aria-label="Search team artifacts"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`); await settle(600);
            assert.equal((await rows()).length, 3, 'cleared: all three');
        });
        await S.run('origin badges: "From build-server" and "Link not verified" (no type or size)', async () => {
            const r = await rows();
            assert.ok(r.some(t => /build-log\.txt/.test(t) && /From build-server/.test(t)), 'the received file says where it is from');
            assert.ok(r.some(t => /ghost\.md/.test(t) && /Link not verified/.test(t) && !/Markdown|KB/.test(t)), 'the unverified one says so and has no type or size');
        });
        await S.run('the pane of a received file lists where it came from and that it was not scanned; Keep toggles and sends PUT then DELETE', async () => {
            await click('#team-panel-artifacts button', /build-log\.txt/); await settle(500);
            const pane = await ev(`window.__na.text(window.__tp.pane())`);
            assert.ok(/Received from\s*build-server/.test(pane) && /Not scanned/.test(pane) && /Board \(claimed by the sender\)\s*ci/.test(pane), `the details are in the pane: ${pane.slice(0, 300)}`);
            assert.ok(await ev(`(() => { const b = [...window.__tp.pane().querySelectorAll('button')].find(x => /^Keep$/.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`), 'a Keep button'); await settle(300);
            assert.equal(await ev(`[...window.__tp.pane().querySelectorAll('button')].find(x => /^Kept$/.test(x.textContent.trim()))?.getAttribute('aria-pressed')`), 'true', 'it is pressed');
            await ev(`[...window.__tp.pane().querySelectorAll('button')].find(x => /^Kept$/.test(x.textContent.trim())).click(); true`); await settle(300);
            assert.deepEqual(await ev(`window.__kept`), ['PUT', 'DELETE'], 'PUT then DELETE');
        });
        await S.run('Delete asks first, then removes the row and puts the focus on the next one', async () => {
            assert.ok(await ev(`(() => { const b = [...window.__tp.pane().querySelectorAll('button')].find(x => /^Delete$/.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`), 'a Delete button');
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the confirmation', 4000);
            assert.equal(await ev(`window.__deleted`), undefined, 'nothing is deleted before the answer');
            await ev(`document.getElementById('confirm-modal-yes').click(); true`); await settle(600);
            assert.equal(await ev(`window.__deleted`), `/api/artifacts/${B}`);
            assert.equal((await rows()).length, 2, `the row is gone: ${JSON.stringify(await rows())}`);
            assert.ok(await ev(`document.activeElement && document.activeElement.classList.contains('team-row-btn')`), 'the focus is on a row, not the page');
        });
        await S.run('Refresh asks the list again', async () => {
            const before = (await ev(`window.__req`)).length;
            assert.ok(await click('#team-panel-artifacts button', /^Refresh$/), 'a Refresh button'); await settle(500);
            assert.ok((await ev(`window.__req`)).length > before, 'a new request');
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
