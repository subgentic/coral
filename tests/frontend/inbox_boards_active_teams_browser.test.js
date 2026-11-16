// The Inbox's Boards group (the phone drawer) lists the active teams by #15744's rule (#17457, coral-hub's request): active first, newest message first, the idle ones behind "Show all teams (n idle)" (remembered in this
// browser), the open board always listed, up to four boards all listed. 390 px, boards from a stubbed /api/board/projects, agents from state.liveSessions. Isolated dev server; found by name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const S = (id, team, extra) => ({ session_id: id, name: id, agent_type: 'claude', working_directory: '/tmp/' + team, board_project: team, display_name: id, sleeping: false, ...extra });
const SESSIONS = [
    S('a1', 'alpha', { last_message: { role: 'agent', text: 'x', at: '2026-11-11T10:00:00Z' } }),
    S('b1', 'beta', { sleeping: true, board_unread: 3, last_message: { role: 'agent', text: 'y', at: '2026-11-11T12:00:00Z' } }),
    S('c1', 'gamma', { last_message: { role: 'agent', text: 'z', at: '2026-11-10T09:00:00Z' } }),
];
const PROJECTS = ['alpha', 'beta', 'gamma', 'idle-1', 'idle-2', 'idle-3', 'idle-4'].map(project => ({ project, board_label: project }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const BOARDS = `[...document.querySelectorAll('.view-list-item[data-key^="board:"]')].map(e => e.textContent.trim().replace(/^forum/, '').replace(/\\s+/g, ' '))`;
    const open = async projects => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral-teams-show-all'); (() => { const real = window.fetch; window.fetch = (u, o = {}) => new URL(String(u), location.origin).pathname === '/api/board/projects' ? Promise.resolve(new Response(JSON.stringify(${JSON.stringify(projects)}), { headers: { 'content-type': 'application/json' } })) : real(u, o); return true; })()`);
        await ev(`window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await open(PROJECTS);
        await waitFor(`${BOARDS}.some(t => /Show all teams/.test(t))`, 'the Boards group with its Show all teams row', 15000);
        let names = await ev(BOARDS);
        assert.deepEqual(names, ['beta', 'alpha', 'gamma', 'Show all teams (4 idle)'], 'active teams, newest message first, the idle four behind the row: ' + JSON.stringify(names));
        const seen = await ev(`(() => { const e = document.querySelector('.view-list-item[data-key^="board:"]'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), vis: getComputedStyle(e).visibility, shown: !!e.offsetParent }; })()`);
        console.log('first board row:', JSON.stringify(seen));
        await shot('boards-active-390');
        await ev(`[...document.querySelectorAll('.view-list-item[data-key^="board:"]')].find(e => /Show all teams/.test(e.textContent)).click(); true`);
        await waitFor(`${BOARDS}.some(t => /Show active teams only/.test(t))`, 'every board after the click', 8000);
        names = await ev(BOARDS);
        assert.equal(names.length, 8, 'all seven boards and the row: ' + JSON.stringify(names));
        assert.equal(await ev(`localStorage.getItem('coral-teams-show-all')`), 'true', 'remembered in this browser');
        await shot('boards-all-390');
        await open(PROJECTS.slice(0, 4));
        await waitFor(`${BOARDS}.length >= 4`, 'four boards', 15000);
        names = await ev(BOARDS);
        assert.deepEqual(names.slice().sort(), ['alpha', 'beta', 'gamma', 'idle-1'], 'up to four boards are all listed, no row: ' + JSON.stringify(names));
        console.log('PASS the Boards group lists the active teams');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
