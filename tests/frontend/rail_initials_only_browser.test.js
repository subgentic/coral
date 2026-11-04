// The collapsed sidebar's agent rows are initials only (#13143, the Operator: "remove the icons except for the teams in the collapse sidebar"): no role icon and no emoji before the initials, the initials centred in
// the tile, the status dot and unread badge kept, and the team row keeps its people icon with its letter. The expanded sidebar is not touched. 1280 px, both themes. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const WHO = [['Orchestrator', 'Orchestrator', ''], ['Backend Dev', 'Backend Dev', ''], ['Senior Reviewer', 'Reviewer', '\u{1F3A8}'], ['Designer', 'Designer', '']];
        await ev(`(() => { window.__m.agents = {}; for (const [n] of ${JSON.stringify(WHO)}) window.__m.add(n, 'A', 1, { sleeping: false, session_id: 'sid-' + n });
            const live = Object.values(window.__m.agents).map(x => window.__m.entry(x));
            for (const [n, role, icon] of ${JSON.stringify(WHO)}) { const s = live.find(x => x.session_id === 'sid-' + n); Object.assign(s, { display_name: n, board_job_title: role, board_project: 'team-a', working: n === 'Backend Dev' }); if (icon) s.icon = icon; }
            window.__RAIL_LIVE = live; return true; })()`);
        await ev(`(() => { localStorage.setItem('coral-group-by-team', 'true'); const layout = document.querySelector('.layout'); if (!layout.classList.contains('sidebar-collapsed')) window.toggleSidebarRail();
            T.state.liveSessions = window.__RAIL_LIVE; T.render.renderLiveSessions(window.__RAIL_LIVE); return true; })()`);
        for (const theme of ['light', 'dark']) {
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            await shot(`rail-initials-${theme}`);
            const r = await ev(`(() => { const list = document.getElementById('sidebar-rail-list'), tiles = [...list.querySelectorAll('.sidebar-rail-item')];
                return { tiles: tiles.map(t => { const tile = t.querySelector('.rail-tile'), tx = t.querySelector('.rail-tile-text'), a = tile.getBoundingClientRect(), b = tx.getBoundingClientRect();
                    return { text: tx.textContent.trim(), icons: tile.querySelectorAll('.rail-tile-icon, .rail-tile-emoji, .material-icons').length, dot: !!t.querySelector('.rail-tile-dot, .rail-tile-badge'), dx: Math.round(Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) * 10) / 10, dy: Math.round(Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) * 10) / 10 }; }),
                  groups: [...list.querySelectorAll('.sidebar-rail-group')].map(g => ({ svg: !!g.querySelector('svg'), letter: !!g.querySelector('.sidebar-rail-letter') })) }; })()`);
            assert.ok(r.tiles.length >= 4, `${theme}: the four agents are in the rail: ` + JSON.stringify(r));
            assert.deepEqual(r.tiles.map(t => t.text).sort(), ['BD', 'DE', 'OR', 'SR'], `${theme}: initials`);
            assert.ok(r.tiles.every(t => t.icons === 0), `${theme}: no role icon or emoji before the initials: ` + JSON.stringify(r.tiles));
            assert.ok(r.tiles.every(t => t.dx <= 1 && t.dy <= 1.5), `${theme}: the initials are centred in the tile: ` + JSON.stringify(r.tiles));
            assert.ok(r.tiles.every(t => t.dot), `${theme}: the status dot or badge is kept`);
            assert.ok(r.groups.length >= 1 && r.groups.every(g => g.svg && g.letter), `${theme}: the team row keeps its people icon and its letter: ` + JSON.stringify(r.groups));
        }
        console.log('PASS the collapsed sidebar: agent rows are initials only, centred; the team row keeps its icon');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
