// The team page's Artifacts tab preview can be widened and maximised (#9410, the operator: "the side artifact preview cannot be expanded"): the pane wears the same handle as the Inbox Artifacts preview, the
// Knowledge entries and a goal's task (detail_pane.js, dock_resize.js): a separator that is dragged wider, kept (coral-detail-width) and applied when another artifact opens, moved with the keys (Home the
// narrowest, End the widest the page allows, which is the pane maximised), and put back by a double click. 1280 px, an artifact list stubbed in the page, isolated dev server; drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-artsz-${Date.now() % 100000}`;
const A = 'a'.repeat(64), B = 'b'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await settle(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const stub = () => ev(`(() => { const R = window.fetch.bind(window);
        const ALL = [
          { id: '${A}', name: 'Settings audit', media_type: 'text/markdown', size: 4200, task_id: 12, task_title: 'Audit settings', created_at: '2026-10-25T06:00:00Z', uri: 'coral://artifacts/${A}', available: true, produced_by: 'QA Engineer', source: 'uploaded' },
          { id: '${B}', name: 'build-log.txt', media_type: 'text/plain', size: 900, task_id: 0, created_at: '2026-10-24T06:00:00Z', uri: 'coral://artifacts/${B}', available: true, source: 'uploaded' }];
        const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) return j({ project: ${JSON.stringify(TEAM)}, artifacts: ALL, has_more: false, total: ALL.length, all: ALL.length });
            if (url.pathname === '/api/system/artifact-store/kept') return j({ kept: [] });
            if (/^\\/api\\/artifacts\\/[a-f0-9]{64}$/.test(url.pathname)) return Promise.resolve(new Response('# Settings audit\\n\\nBody.', { headers: { 'Content-Type': 'text/markdown' } }));
            return R(u, o); }; return true; })()`);
    const width = () => ev(`Math.round(window.__tp.pane().getBoundingClientRect().width)`);
    const key = async (k, code, vk) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    const drag = async dx => { const r = await ev(`(() => { const b = document.querySelector('.detail-grip').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 200) }; })()`); const I = client.Input;
        await I.dispatchMouseEvent({ type: 'mouseMoved', x: r.x, y: r.y }); await I.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await I.dispatchMouseEvent({ type: 'mouseMoved', x: r.x + dx, y: r.y, button: 'left' }); await I.dispatchMouseEvent({ type: 'mouseReleased', x: r.x + dx, y: r.y, button: 'left', clickCount: 1 }); };
    const openRow = async rx => { assert.ok(await ev(`(() => { const b = [...document.querySelectorAll('#team-panel-artifacts tbody .dt-primary')].find(x => ${rx}.test(x.textContent)); if (!b) return false; b.focus(); b.click(); return true; })()`), `no row ${rx}: ` + await ev(`(document.querySelector('#team-panel-artifacts') || document.body).innerText.slice(0, 300) + ' | ' + document.querySelectorAll('#team-panel-artifacts tbody tr').length`)); await settle(300); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await ev(`localStorage.removeItem('coral-detail-width'); true`);
        await seed(ev, TEAM); await stub(); await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Artifacts'); await waitFor(`document.querySelectorAll('#team-panel-artifacts tbody tr').length >= 2`, 'the two artifacts', 10000);
        await S.run('an artifact opens in the right pane with the shared handle: a separator, named, with the dock\'s limits', async () => {
            await openRow('/Settings audit/'); await waitFor(`!!window.__tp.pane() && !!document.querySelector('.detail-grip')`, 'the pane and its handle', 8000);
            const sep = await ev(`(() => { const g = document.querySelector('.detail-grip'); return { role: g.getAttribute('role'), name: g.getAttribute('aria-label'), min: g.getAttribute('aria-valuemin'), tab: g.tabIndex }; })()`);
            assert.deepEqual([sep.role, sep.name, sep.min, sep.tab], ['separator', 'Resize the details', '280', 0]);
            assert.equal(await width(), 460, 'it opens at the pane\'s own 460 px');
            await shot('team-artifacts-preview-default');
        });
        await S.run('dragged wider it keeps the width, and another artifact opens at it', async () => {
            await drag(-200); await waitFor(`Math.abs(Math.round(window.__tp.pane().getBoundingClientRect().width) - 660) <= 1`, 'the pane 200 px wider', 5000); const kept = await width();
            assert.equal(await ev(`localStorage.getItem('coral-detail-width')`), String(kept), 'the width is remembered');
            await openRow('/build-log/'); await settle(200); assert.equal(await width(), kept, 'another artifact opens at the kept width');
        });
        await S.run('End maximises it to the page\'s room less 380 (the list keeps Name and Updated), Home takes it to the narrowest, a double click puts it back', async () => {
            await ev(`document.querySelector('.detail-grip').focus(); true`); await key('End', 'End', 35);
            const max = await ev(`Math.round(document.getElementById('team-page-row').getBoundingClientRect().width) - 380`);
            assert.ok(Math.abs((await width()) - max) <= 1, `End is the page's room less 380 (${await width()} / ${max})`); assert.ok(max > 800, 'and that is wide: ' + max);
            const list = await ev(`(() => { const t = document.querySelector('#team-panel-artifacts table'); return { w: Math.round(t.getBoundingClientRect().width), th: [...t.querySelectorAll('th')].filter(h => h.getClientRects().length).map(h => h.textContent.trim().replace(/[\\u2195\\u2191\\u2193]/g, '')) }; })()`);
            assert.ok(list.th.some(h => /^Name/i.test(h)) && list.th.some(h => /^Updated/i.test(h)), `the list keeps its Name and Updated at the widest: ${JSON.stringify(list)}`);
            await shot('team-artifacts-preview-maximised');
            await key('Home', 'Home', 36); assert.equal(await width(), 280, 'Home is the narrowest');
            await ev(`document.querySelector('.detail-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
            assert.equal(await width(), 460, 'a double click puts it back'); assert.equal(await ev(`localStorage.getItem('coral-detail-width')`), null, 'and forgets the width');
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
