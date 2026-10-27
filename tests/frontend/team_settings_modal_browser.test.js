// Team settings open in a popout modal, not a tab (#8853, Goal #72): the team page has no Settings tab; the header's Settings button (a phone's More menu item) and the sidebar menu's Team settings open a dialog with
// Workflow, Health check, Messaging and Prompts; a change makes Escape ask before it closes (Keep editing leaves it open, Discard closes), Escape closes it otherwise, Tab stays inside, focus returns to what opened
// it, and on a phone it fills the screen. Real isolated board seeded by the team page helpers. 1280 and 390, light and dark shots. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, openSettings, closeSettings } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const fs = require('node:fs');
const path = require('node:path');

const TEAM = `qa-tsm-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async (name, theme) => { // the review shots, when a folder is given (CORAL_SCREENSHOT_DIR)
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return;
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await settle(250);
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const modal = () => ev(`(() => { const m = document.querySelector('.team-settings-modal'); if (!m) return null; const c = m.querySelector('.modal-content').getBoundingClientRect(); return { title: m.querySelector('h3').textContent.trim(), role: m.getAttribute('role'), modalAttr: m.getAttribute('aria-modal'), sections: [...m.querySelectorAll('[role=tab], select option')].map(e => e.textContent.trim()).filter(Boolean), ready: !!m.querySelector('#team-settings-workspace .sv[data-ready]'), w: Math.round(c.width), h: Math.round(c.height), vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, mw: Math.round(m.getBoundingClientRect().width) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM); await settle(800);

            const tabs = await ev(`window.__tp.allTabs().map(t => window.__tp.tabLabel(t))`);
            check(`${label}: the team page has no Settings tab (Goals, Agents, Tasks, Artifacts, Knowledge, Board)`, JSON.stringify(tabs) === JSON.stringify(['Goals', 'Agents', 'Tasks', 'Artifacts', 'Knowledge', 'Board']), JSON.stringify(tabs));
            const btn = await ev(`(() => { const b = document.getElementById('team-page-settings'), a = document.getElementById('team-page-add-agent'), m = document.getElementById('team-page-more'); const vis = e => !!e && e.getClientRects().length > 0; return { settings: vis(b), add: vis(a), more: vis(m), order: vis(b) && vis(a) && vis(m) ? [a, b, m].map(e => Math.round(e.getBoundingClientRect().left)) : null }; })()`);
            if (!mobile) check(`${label}: a Settings button sits beside Add agent and More (Add agent, Settings, More, left to right)`, btn.settings && btn.add && btn.more && btn.order[0] < btn.order[1] && btn.order[1] < btn.order[2], JSON.stringify(btn));
            else check(`${label}: a phone's header has the one More button, and Settings is its menu item`, !btn.settings && btn.more, JSON.stringify(btn));

            await ev(`window.__opener = (function () { const b = document.getElementById('team-page-settings'); return b && b.getClientRects().length ? b : document.getElementById('team-page-more'); })(); true`);
            await openSettings(ev, settle);
            const m = await modal();
            check(`${label}: the Settings button opens a dialog named "Team settings: <team>" with Workflow, Health check, Messaging and Prompts`, m && m.role === 'dialog' && m.modalAttr === 'true' && m.title === `Team settings: ${TEAM}` && ['Workflow', 'Health check', 'Messaging', 'Prompts'].every(s => m.sections.includes(s)) && m.ready, JSON.stringify(m));
            if (mobile) check(`${label}: on a phone it fills the screen`, m && m.w >= m.mw - 1 && m.h >= m.vh - 1 && m.mw >= m.vw - 1, JSON.stringify({ w: m.w, h: m.h, mw: m.mw, vw: m.vw, vh: m.vh }));
            const foot = await ev(`(() => { const m = document.querySelector('.team-settings-modal'), bar = m.querySelector('.sv-bar'), c = m.querySelector('.modal-content').getBoundingClientRect(), b = bar.getBoundingClientRect(), cancel = bar.querySelector('.sv-cancel'), save = bar.querySelector('.sv-save'), ren = m.querySelector('.board-rename-toggle'), lab = m.querySelector('.sv-row .sv-label'); const rg = ren && document.createRange(); if (rg) rg.selectNodeContents(ren); const r = rg && rg.getBoundingClientRect(), l = lab && lab.getBoundingClientRect(); /* the link's text, not its box */ return { inView: b.height > 0 && b.bottom <= c.bottom + 1 && b.top >= c.top, atFoot: Math.abs(c.bottom - b.bottom) < 3, cancelOn: !cancel.disabled, saveOff: save.disabled, order: cancel.getBoundingClientRect().left < save.getBoundingClientRect().left, btnH: Math.round(save.getBoundingClientRect().height), renameLeft: r && l ? Math.round(r.left - l.left) : null, chain: (() => { const out = []; for (let e = bar; e && e !== m; e = e.parentElement) { const q = e.getBoundingClientRect(), cs = getComputedStyle(e); out.push(e.className.toString().slice(0, 24) + ' ' + Math.round(q.left) + '-' + Math.round(q.right) + ' b' + Math.round(q.bottom) + ' pad ' + cs.padding); } return out; })() }; })()`);
            check(`${label}: the foot (status, Cancel, Save settings) is in view at the dialog's bottom, Cancel is never disabled, Save waits for a change`, foot.inView && foot.atFoot && foot.cancelOn && foot.saveOff && foot.order && (!mobile || foot.btnH >= 44), JSON.stringify(foot));
            if (mobile) check(`${label}: the title and the close button keep a 16 px edge`, await ev(`(() => { const h = document.querySelector('.team-settings-modal h3').getBoundingClientRect(), x = document.querySelector('.team-settings-modal .modal-close-btn').getBoundingClientRect(); return h.left >= 15 && document.documentElement.clientWidth - x.right >= 8; })()`));
            if (mobile) check(`${label}: the Rename board link starts at its label's left edge`, foot.renameLeft !== null && Math.abs(foot.renameLeft) <= 1, String(foot.renameLeft));
            await shot(`team-settings-modal-${label}-dark`, 'dark');
            await shot(`team-settings-modal-${label}-light`, 'light');

            // Tab stays inside the dialog
            let outside = 0;
            for (let i = 0; i < 25; i++) { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); if (!(await ev(`!!document.activeElement && !!document.activeElement.closest('.team-settings-modal')`))) { outside++; console.log('DBG outside', await ev(`(document.activeElement && (document.activeElement.tagName + '#' + document.activeElement.id + '.' + document.activeElement.className)) || 'none'`)); } }
            check(`${label}: Tab stays inside the dialog (25 presses)`, outside === 0, String(outside));

            // a change: Escape asks; Keep editing leaves the dialog open
            await ev(`(() => { const m = document.querySelector('.team-settings-modal'); const t = [...m.querySelectorAll('[role=tab]')].find(x => /Health check/.test(x.textContent)); if (t) t.click(); else { const s = m.querySelector('select'); if (s) { s.value = [...s.options].find(o => /Health check/.test(o.textContent)).value; s.dispatchEvent(new Event('change', { bubbles: true })); } } return true; })()`); await settle(300);
            await ev(`(() => { const m = document.querySelector('.team-settings-modal'); const sw = [...m.querySelectorAll('[role=switch], input[type=checkbox]')].find(e => e.getClientRects().length); if (sw) sw.click(); return !!sw; })()`); await settle(300);
            const dirty = await ev(`!!(document.getElementById('team-settings-workspace') && document.getElementById('team-settings-workspace').hasUnsaved && document.getElementById('team-settings-workspace').hasUnsaved())`);
            check(`${label}: a switch changed makes the settings unsaved`, dirty);
            const bar = await ev(`(() => { const b = document.querySelector('.team-settings-modal .sv-bar'), c = document.querySelector('.team-settings-modal .modal-content').getBoundingClientRect(), r = b.getBoundingClientRect(); return { save: !b.querySelector('.sv-save').disabled, cancel: !b.querySelector('.sv-cancel').disabled, status: (b.querySelector('.sv-status') || b.firstElementChild).textContent.trim(), inView: r.bottom <= c.bottom + 1 && r.height > 0 }; })()`);
            check(`${label}: with a change Save is on, the status says what changed, the foot is still in view`, bar.save && bar.cancel && bar.status.length > 0 && !/^No changes/.test(bar.status) && bar.inView, JSON.stringify(bar));
            await shot(`team-settings-modal-${label}-changed-dark`, 'dark'); await shot(`team-settings-modal-${label}-changed-light`, 'light');
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await waitFor(`!!document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${label}: the unsaved question`, 6000);
            check(`${label}: Escape with an unsaved change asks "Unsaved Team Settings" and the dialog stays`, /Unsaved Team Settings/.test(await ev(`document.getElementById('confirm-modal').textContent`)) && !!(await modal()));
            await shot(`team-settings-modal-${label}-unsaved-question-dark`, 'dark'); await shot(`team-settings-modal-${label}-unsaved-question-light`, 'light');
            await ev(`document.getElementById('confirm-modal-no') ? document.getElementById('confirm-modal-no').click() : [...document.querySelectorAll('#confirm-modal button')].find(b => /cancel|keep/i.test(b.textContent)).click(); true`); await settle(300);
            check(`${label}: Keep editing leaves the dialog open`, !!(await modal()));
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await waitFor(`!!document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, `${label}: the unsaved question again`, 6000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`); await settle(500);
            check(`${label}: Leave without saving closes it, and focus is back on the button that opened it`, !(await modal()) && (await ev(`document.activeElement === window.__opener || (document.activeElement && document.activeElement.id === window.__opener.id)`)), await ev(`document.activeElement && (document.activeElement.id || document.activeElement.className)`));

            // with nothing changed, Escape closes it at once
            await openSettings(ev, settle);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await settle(500);
            check(`${label}: with nothing changed Escape closes it`, !(await modal()));

            // the sidebar menu's Team settings (the action every team row's menu has) opens the same dialog
            await ev(`window.showTeamWorkingModeWorkspace(${JSON.stringify(TEAM)}); true`);
            await waitFor(`!!document.querySelector('.team-settings-modal #team-settings-workspace .sv[data-ready]')`, `${label}: the dialog from the sidebar's Team settings`, 8000);
            check(`${label}: the sidebar menu's Team settings opens the same dialog (no team page needed)`, !!(await modal()));
            await closeSettings(ev, settle);
        }
    } finally { await removeBoards?.(ev, [TEAM]).catch?.(() => {}); await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} team settings modal checks passed`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
