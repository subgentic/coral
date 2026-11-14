// #15912 (the Operator: "We lost the search in our sidebar for the inbox"): the Inbox sidebar shows its search box again on a desktop (hidden above each tab since #11859), shared with the page's box, and the rail's search opens it; a phone keeps the one box. (Needs you, Tasks, Goals, Saved, Artifacts, Activity...) with its count badge, a tooltip and an
// Through agent_view_harness.js against the isolated dev server.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const agent = { name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: new Date(Date.now() - 60000).toISOString() };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.setItem('coral-alerts-offered', '1'); localStorage.setItem('coral-alerts-reoffered', '1'); true`);
        await ev(INBOX_WORLD);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(agent)}]; window.switchNavTab('hub-inbox'); m.updateInboxTab(); return true; })()`);
        await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] [data-key="needs"]')`, 'the folder list', 8000);
        const vis = id => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); const r = e && e.getBoundingClientRect(); return !!e && e.getClientRects().length > 0 && r.width > 80; })()`);
        const typeIn = async (id, text) => { await ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`); await ev(framesJs(8)); };
        const val = id => ev(`document.getElementById(${JSON.stringify(id)})?.value`);
        // 1440, expanded: the sidebar's own search is on screen above the folders, beside the page's box
        check(await vis('inbox-search'), 'at 1440 the Inbox sidebar shows its search box');
        await shot('inbox-sidebar-search-1440');
        await typeIn('inbox-search', 'backend');
        check(await val('inbox-needs-search') === 'backend', "words typed in the sidebar's box are in the page's box: " + await val('inbox-needs-search'));
        await typeIn('inbox-needs-search', 'frontend');
        check(await val('inbox-search') === 'frontend', "words typed in the page's box are in the sidebar's box: " + await val('inbox-search'));
        await ev(`document.querySelector('[data-view-list="inbox-folders"] [data-key="tasks"]').click(); true`); await ev(framesJs(8));
        check(await vis('inbox-search') && /tasks/i.test(await ev(`document.getElementById('inbox-search').getAttribute('aria-label')`)), 'on Tasks the sidebar box names Tasks');
        // collapsed: the rail's search opens the sidebar and focuses the box
        await ev(`window.toggleSidebarRail(); true`); await ev(framesJs(6));
        await waitFor(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`, 'the sidebar collapses', 4000);
        await ev(`document.getElementById('sidebar-rail-search').click(); true`); await ev(framesJs(8));
        const after = await ev(`({ collapsed: document.querySelector('.layout').classList.contains('sidebar-collapsed'), focus: document.activeElement?.id })`);
        check(!after.collapsed && after.focus === 'inbox-search', "the rail's search opens the sidebar with its search focused: " + JSON.stringify(after));
        // 390: one search on the page (the page's box in the pill), the sidebar's is not drawn
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(INBOX_WORLD);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(agent)}]; window.switchNavTab('hub-inbox'); m.updateInboxTab(); return true; })()`);
        await ev(framesJs(10));
        const boxes = await ev(`[...document.querySelectorAll('input[type=search]')].filter(e => e.getClientRects().length).map(e => e.id || e.className.slice(0, 24))`);
        check(boxes.length === 1 && !boxes.includes('inbox-search'), 'at 390 the Inbox shows one search box and it is not the sidebar\'s: ' + JSON.stringify(boxes));
        await shot('inbox-sidebar-search-390');
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
