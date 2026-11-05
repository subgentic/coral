// The board panel's head line is one ... menu (the Operator, #13585; it was the team's name, a Table|Chat switch and Pause and Export icons): "Show as chat|table", "Pause board|Resume board", "Export" and
// "Open full board", each a menu item with its name; the paused board's banner stays; the menu button is 24 px or more (44 on a phone); both themes read at 4.5:1. Against a real board on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const board = `qa-icons-5491-${Date.now()}`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const head = '#agentic-panel-board .board-chat-search'; // the ... menu is the search row's
    const line = '#agentic-panel-board .board-chat-header'; // the old head line: nothing left in it to see
    const state = () => ev(`(() => { const h = document.querySelector('${line}'), m = document.querySelector('${head} .list-bar-more-btn'), r = m.getBoundingClientRect();
        return { more: { label: m.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), expanded: m.getAttribute('aria-expanded') },
            visible: [...h.querySelectorAll('button, a, input, [role=button]')].filter(e => e.getClientRects().length).length,
            oldControls: !!(h.querySelector('.board-chat-title, #board-chat-pause-btn, .board-select-btn, .mb-view-switch, .mb-table-tools')),
            visibleText: [...h.querySelectorAll('*')].filter(e => e.getClientRects().length && e.children.length === 0 && !e.classList.contains('sr-only')).map(e => e.textContent.trim()).join(''),
            banner: getComputedStyle(document.getElementById('board-chat-paused-banner')).display !== 'none' }; })()`);
    const items = () => ev(`[...document.querySelectorAll('${head} .list-bar-more-menu .menu-item')].map(x => [x.textContent, x.getAttribute('role')])`);
    const choose = async label => { await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`); await waitFor(`!document.querySelector('${head} .list-bar-more-menu').hidden`, `the menu is open for ${label}`, 4000); await ev(`[...document.querySelectorAll('${head} .list-bar-more-menu .menu-item')].find(x => x.textContent === ${JSON.stringify(label)}).click(); true`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [view, theme] of [[{ w: 1280, h: 900, phone: false }, 'light'], [{ w: 1280, h: 900, phone: false }, 'dark'], [{ w: 390, h: 844, phone: true }, 'light'], [{ w: 390, h: 844, phone: true }, 'dark']]) {
            const tag = `${view.w}px ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
            await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev); await installAudit(ev); await setTheme(ev, theme);
            await ev(`fetch('/api/board/${board}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'qa-5491', as: 'QA', content: 'hello' }) }).then(r => r.status)`);
            await ev(`fetch('/api/board/${board}/resume', { method: 'POST' }).then(r => r.status)`);
            await ev(`window.__m.add('icons-bot', 'A', 4, { sleeping: false, board_project: ${JSON.stringify(board)} }); true`); await new Promise(r => setTimeout(r, 600)); // sleep-ok: the agent list draws over a few frames
            await ev(`window.selectLiveSession('icons-bot', 'claude', 'icons-bot-id', 'local'); true`); await new Promise(r => setTimeout(r, 900)); // sleep-ok: the agent's tabs draw over a few frames
            await ev(`window.switchAgenticTab('board', 'top'); true`);
            if (view.phone) await ev(`(() => { const side = document.getElementById('agentic-state'); if (side && side.getBoundingClientRect().width === 0) window.toggleAgenticPanel(true); return true; })()`); // a phone shows the side panel as a drawer
            await waitFor(`!!document.querySelector('${head} .list-bar-more-btn') && document.querySelector('${head} .list-bar-more-btn').getClientRects().length > 0`, `${tag}: the board panel`, 8000);
            await waitFor(`document.getElementById('board-chat-paused-banner')`, `${tag}: the banner is there`, 5000);
            if (process.env.CORAL_SCREENSHOT_DIR) require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/board-head-${view.w}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            let s = await state();
            check(`${tag}: the head line has nothing visible: no team name, no Table|Chat, no Pause, no Export icon (${JSON.stringify(s)})`, s.visible === 0 && !s.oldControls && s.visibleText === '' && s.more.label === 'More board actions');
            check(`${tag}: the menu button is a real target (${s.more.w}x${s.more.h})`, view.phone ? s.more.w >= 44 && s.more.h >= 44 : s.more.w >= 24 && s.more.h >= 24);
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            await waitFor(`!document.querySelector('${head} .list-bar-more-menu').hidden`, `${tag}: the menu opens`, 4000);
            const it = await items();
            check(`${tag}: the menu starts with Show as chat, Pause board, Export, Open full board, each a menuitem (${JSON.stringify(it)})`, JSON.stringify(it.slice(0, 4)) === JSON.stringify([['Show as chat', 'menuitem'], ['Pause board', 'menuitem'], ['Export', 'menuitem'], ['Open full board', 'menuitem']]) && it.some(x => x[0] === 'Jump to latest message'));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            // Pause: the banner shows, the item says Resume
            await choose('Pause board');
            await waitFor(`getComputedStyle(document.getElementById('board-chat-paused-banner')).display !== 'none'`, `${tag}: paused: the banner shows`, 6000);
            check(`${tag}: pausing is announced in a polite live region`, await ev(`(() => { const r = document.getElementById('board-chat-pause-status'); return !!r && r.getAttribute('role') === 'status' && r.getAttribute('aria-live') === 'polite' && /Board paused/.test(r.textContent); })()`));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            check(`${tag}: paused: the item says Resume board`, (await items()).some(x => x[0] === 'Resume board') && !(await items()).some(x => x[0] === 'Pause board'));
            if (process.env.CORAL_SCREENSHOT_DIR) require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/board-head-${view.w}-${theme}-paused.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            const au = await auditRegion(ev, [head, '#board-chat-paused-banner'], { focus: [`${head} .list-bar-more-btn`] });
            check(`${tag}: readable (4.5:1) with a focus ring, paused too (${au.checked} checked)`, au.fails.length === 0, JSON.stringify(au.fails.slice(0, 2)));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            await choose('Resume board');
            await waitFor(`getComputedStyle(document.getElementById('board-chat-paused-banner')).display === 'none'`, `${tag}: resumed: no banner`, 6000);
            check(`${tag}: resuming is announced too`, await ev(`/Board resumed/.test(document.getElementById('board-chat-pause-status').textContent)`));
            // Export: select mode starts, and the item says how to stop
            await choose('Export');
            check(`${tag}: Export starts select mode (the select bar is up)`, await ev(`!!document.getElementById('board-chat-select-bar') && getComputedStyle(document.getElementById('board-chat-select-bar')).display !== 'none'`));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            check(`${tag}: and the item then says Stop exporting`, (await items()).some(x => x[0] === 'Stop exporting'));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            await choose('Stop exporting');
            check(`${tag}: which leaves select mode`, await ev(`getComputedStyle(document.getElementById('board-chat-select-bar')).display === 'none'`));
            // Table | Chat: one item that names the other view
            await choose('Show as chat');
            check(`${tag}: Show as chat switches the board to chat`, await ev(`import(${S} + 'board_table.js').then(m => m.boardView())`) === 'chat');
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            check(`${tag}: in Chat view the menu leaves out Expand all and Collapse all (the table's)`, !(await items()).some(x => x[0] === 'Expand all' || x[0] === 'Collapse all') && (await items()).some(x => x[0] === 'Jump to latest message'));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            check(`${tag}: and the item then says Show as table`, (await items()).some(x => x[0] === 'Show as table'));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            await choose('Show as table');
            check(`${tag}: and back`, await ev(`import(${S} + 'board_table.js').then(m => m.boardView())`) === 'table');
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            check(`${tag}: and Table view has them again`, (await items()).some(x => x[0] === 'Expand all') && (await items()).some(x => x[0] === 'Collapse all'));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            // the Board page writes the pause too: the dock's banner and menu follow
            await require('./helpers/team_board').openBoardPage(ev, waitFor, board); // the Board page is the team page's Messages tab (#8129)
            await ev(`import(${S} + 'message_board.js').then(m => m.toggleBoardPause()).then(() => true)`);
            await waitFor(`getComputedStyle(document.getElementById('board-chat-paused-banner')).display !== 'none'`, `${tag}: paused from the page: the dock's banner`, 6000);
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            check(`${tag}: pausing from the Board page: the dock's menu says Resume board`, (await items()).some(x => x[0] === 'Resume board'));
            await ev(`document.querySelector('${head} .list-bar-more-btn').click(); true`);
            await ev(`import(${S} + 'message_board.js').then(m => m.toggleBoardPause()).then(() => true)`);
            await waitFor(`getComputedStyle(document.getElementById('board-chat-paused-banner')).display === 'none'`, `${tag}: resumed from the page`, 6000);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await ev(`fetch('/api/board/${board}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {});
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); try { await ev(`fetch('/api/board/${board}', { method: 'DELETE' }).then(r => r.status)`); } catch (_) {} await client.close().catch(() => {}); process.exit(1); }
})().catch(e => { console.error(e); process.exitCode = 1; });
