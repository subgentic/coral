// #17510 M5/M9/L1/L2: the team resets its sidebar, Default remains visible with the reported effort,
// and Commands explains the ? shortcut. The / listing says where it works. M6 is covered by #17461.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');
const { install: installTP, seed } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `qa-walk73-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const problems = [];
    const check = (ok, label) => { if (!ok) problems.push(label); };
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' });
        await Page.loadEventFired();
        await install();
        await coralReady(ev);
        await setTheme(ev, 'light');
        await installTP(ev);
        await seed(ev, TEAM);
        // A known previous pane, then a real team-page open: no live Skills import is needed to reproduce the stale pane.
        await ev(`import((window.__coralStatic || '/static/') + 'sidebar.js').then(m => m.showSidebarPane('skills')).then(() => true)`);
        await ev(`window.openTeamPage(${JSON.stringify(TEAM)}, { tab: 'goals' }).then(() => true)`);
        await waitFor(`document.getElementById('team-page-view').getClientRects().length > 0`, 'team page');
        check(await ev(`document.querySelector('.layout').dataset.sidebarPane === 'agents' && !document.querySelector('.sidebar-pane[data-pane="agents"]').hidden && document.querySelector('.sidebar-pane[data-pane="skills"]').hidden`), 'the team replaces the previous Skills pane with Agents');
        await ev(framesJs(3));
        await shot('team-sidebar-1920');

        await select('sid-1');
        await ev(`import((window.__coralStatic || '/static/') + 'model_chip.js').then(m => { m.updateModelChip({ name: 'Orchestrator', agent_type: 'claude', model: 'haiku', thinking: '', thinking_actual: 'medium' }, ''); return true; })`);
        check(await ev(`document.getElementById('thinking-chip-text').textContent === 'Default · Medium'`), 'Default keeps its name alongside the actual Medium level');
        await ev(framesJs(3));
        await shot('default-effort-1920');
        await ev(`import((window.__coralStatic || '/static/') + 'model_chip.js').then(m => { m.updateModelChip({ name: 'Orchestrator', agent_type: 'claude', thinking: 'medium', thinking_actual: 'medium' }, ''); return true; })`);
        assert.equal(await ev(`document.getElementById('thinking-chip-text').textContent`), 'Medium', 'an explicitly selected level is still simply Medium');

        await ev(`import((window.__coralStatic || '/static/') + 'jump_to.js').then(m => m.openJumpTo('commands')).then(() => true)`);
        await waitFor(`!!document.querySelector('#jump-list .jump-option')`, 'Commands');
        check(await ev(`[...document.querySelectorAll('#jump-list .jump-option')].some(e => e.textContent.includes('Keyboard shortcuts (?)'))`), 'Commands advertises ?');
        await shot('commands-1920');
        await ev(`document.getElementById('jump-modal').style.display = 'none'; true`);
        await ev(`import((window.__coralStatic || '/static/') + 'shortcuts.js').then(m => m.showShortcuts()).then(() => true)`);
        check(await ev(`[...document.querySelectorAll('#shortcuts-body .kbd-row')].some(e => e.querySelector('dt').textContent === '/' && /Agents page/.test(e.querySelector('dd').textContent))`), 'the slash shortcut explains its page scope');
        assert.ok(await ev(`document.querySelectorAll('#shortcuts-body .kbd-group').length === 4`), 'the lazy dialog keeps its four groups');
        await shot('shortcuts-1920');
        assert.deepEqual(problems, []);
        console.log('walk73_navigation: ok');
    } finally {
        await removeBoards(ev, [TEAM]);
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
