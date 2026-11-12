// #15347 (the Operator: "Collapsing the inbox can still show the icons"): a collapsed Inbox sidebar keeps one icon per folder (Needs you, Tasks, Goals, Saved, Artifacts, Activity...) with its count badge, a tooltip and an
// accessible name; a click opens that folder with the rail still collapsed; expanded, the rail has no folder icons. 1280 px, through agent_view_harness.js against the isolated dev server.
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
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.setItem('coral-alerts-offered', '1'); localStorage.setItem('coral-alerts-reoffered', '1'); true`);
        await ev(INBOX_WORLD);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(agent)}]; window.switchNavTab('hub-inbox'); m.updateInboxTab(); return true; })()`);
        await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] [data-key="needs"]')`, 'the folder list', 8000);
        const rail = () => ev(`(() => { const r = document.getElementById('sidebar-rail-inbox'); const shown = !!r && r.getClientRects().length > 0; return { shown, buttons: shown ? [...r.querySelectorAll('button')].map(b => ({ key: b.dataset.key, name: b.getAttribute('aria-label'), title: b.title, badge: b.querySelector('.sidebar-rail-badge')?.textContent || '', w: Math.round(b.getBoundingClientRect().width), icon: !!b.querySelector('.view-list-icon') })) : [], agentsList: document.getElementById('sidebar-rail-list').getClientRects().length > 0, collapsed: document.querySelector('.layout').classList.contains('sidebar-collapsed') }; })()`);
        let r = await rail();
        check(!r.shown, 'expanded, the rail has no folder icons: ' + JSON.stringify(r));
        await ev(`window.toggleSidebarRail(); true`); await ev(framesJs(6));
        await waitFor(`document.querySelector('.layout').classList.contains('sidebar-collapsed')`, 'the sidebar collapses', 4000);
        r = await rail();
        const keys = r.buttons.map(b => b.key);
        check(r.shown && ['needs', 'tasks', 'goals'].every(k => keys.includes(k)), 'collapsed, the rail shows an icon for Needs you, Tasks and Goals: ' + JSON.stringify(r));
        check(r.buttons.every(b => b.icon && b.name && b.title && b.w >= 28), 'each icon has a glyph, an accessible name, a tooltip and room to click: ' + JSON.stringify(r.buttons));
        const needs = r.buttons.find(b => b.key === 'needs');
        check(needs && needs.badge === '1' && /Needs you, 1/.test(needs.name), 'Needs you carries its count in the badge and in its name: ' + JSON.stringify(needs));
        check(r.buttons.some(b => b.key !== 'needs' && /, \d/.test(b.name)), 'the world has a folder besides Needs you with a count in its name (else the next check proves nothing): ' + JSON.stringify(r.buttons.map(b => [b.key, b.name])));
        check(r.buttons.filter(b => b.key !== 'needs').every(b => !b.badge), 'only Needs you has a red badge, the other folders have none (#15797): ' + JSON.stringify(r.buttons.map(b => [b.key, b.badge])));
        check(!r.agentsList, 'the agents list is not drawn over the Inbox folders: ' + JSON.stringify(r));
        await shot('inbox-rail-icons');
        await ev(`document.querySelector('#sidebar-rail-inbox [data-key="tasks"]').click(); true`); await ev(framesJs(8));
        const after = await ev(`({ collapsed: document.querySelector('.layout').classList.contains('sidebar-collapsed'), current: document.querySelector('#sidebar-rail-inbox [aria-current="page"]')?.dataset.key, path: location.pathname })`);
        check(after.collapsed && after.current === 'tasks', 'a click opens the folder and the rail stays collapsed: ' + JSON.stringify(after));
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
