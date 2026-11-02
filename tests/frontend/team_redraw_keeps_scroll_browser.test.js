// #12357 (the audit after #12354): scrollIntoView moves every scrolled ancestor, so a draw that is not a person's click pulled a scrolled page back to its tab strip. Two such calls: the team page's tab strip when a
// count arrives on a poll (drawCounts), and the preview pane's tab strip when a title arrives (revealActiveTab). A page scrolled down, a count that changes, the strip redrawn: the scroll positions are the ones they were.
// Real isolated dev server (helpers/team_page.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-redraw-${Date.now() % 100000}`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 420, deviceScaleFactor: 1, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        await openTeam(ev, waitFor, TEAM);
        // 1. the team page: scroll every scrollable ancestor of the tab strip down, change a count, let the page read its counts at once (the event a Wake or Sleep sends)
        const r = await ev(`(async () => {
            const tab = document.getElementById('team-tab-goals');
            const view = document.getElementById('team-page-view'); const pad = document.createElement('div'); pad.id = 'redraw-pad'; pad.style.height = '3000px'; view.append(pad); const was = view.style.cssText; view.style.cssText += ';flex:none;height:3400px'; // overflow: hidden boxes still scroll (a focus, a scrollIntoView), and that is what pulled the page
            const ups = []; for (let e = tab.parentElement; e; e = e.parentElement) ups.push(e);
            for (const e of ups) e.scrollTop = 300;
            const kept = ups.map(e => [e, e.scrollTop]).filter(([, t]) => t > 0);
            await fetch('/api/board/${TEAM}/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'A late goal', outcome: 'o', done_when: 'd', state: 'active', subscriber_id: 'Orchestrator' }) });
            const before = document.querySelector('#team-tab-goals .team-tab-count')?.textContent;
            document.dispatchEvent(new CustomEvent('coral:team-sleep-changed', { detail: { team: ${JSON.stringify(TEAM)} } }));
            await new Promise(r => setTimeout(r, 1200)); // sleep-ok: a late scroll would show here, there is no event to wait for
            const after = document.querySelector('#team-tab-goals .team-tab-count')?.textContent;
            const out = { scrolled: kept.length, before, after, moved: kept.filter(([e, t]) => e.scrollTop !== t).map(([e, t]) => e.id || e.className || e.tagName).slice(0, 3) };
            pad.remove(); view.style.cssText = was; return out; })()`);
        assert.ok(r.scrolled > 0, 'a page ancestor of the tab strip was scrolled down: ' + JSON.stringify(r));
        assert.notEqual(r.after, r.before, 'the goals count changed, so the strip was redrawn: ' + JSON.stringify(r));
        assert.deepEqual(r.moved, [], 'a count arriving does not scroll the page back to the tab strip: ' + JSON.stringify(r));
        // 2. the preview pane: its tab strip is revealed when a title arrives; a scrolled ancestor stays
        const p = await ev(`(async () => {
            const lay = await import((window.__coralStatic || '/static/') + 'preview_layout.js');
            const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:200px;overflow:auto;background:#fff;z-index:99999';
            const bar = document.createElement('div'); bar.id = 'preview-tabs'; bar.style.cssText = 'display:flex;overflow-x:auto;width:200px';
            for (let i = 0; i < 6; i++) { const t = document.createElement('div'); t.className = 'preview-tab' + (i === 5 ? ' active' : ''); t.style.cssText = 'flex:none;width:120px;height:30px'; t.textContent = 'tab ' + i; bar.append(t); }
            const tall = document.createElement('div'); tall.style.height = '1200px'; box.append(bar, tall); document.body.append(box);
            box.scrollTop = 500; const before = box.scrollTop;
            const api = lay.createPreviewLayout({ getTabs: () => [], isTaskPreview: () => false, getLastOpenedPath: () => '', _onToolbarClick() {} });
            api.revealActiveTab(); await new Promise(r => setTimeout(r, 300)); // sleep-ok: a late scroll would show here, there is no event to wait for
            const out = { before, after: box.scrollTop, left: bar.scrollLeft }; box.remove(); return out; })()`);
        assert.ok(p.before >= 400, 'the box was scrolled down: ' + JSON.stringify(p));
        assert.ok(p.left > 0, 'the active tab was brought into view sideways: ' + JSON.stringify(p));
        assert.equal(p.after, p.before, 'revealing the active tab does not scroll what is above the strip: ' + JSON.stringify(p));
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    console.log('team_redraw_keeps_scroll_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
