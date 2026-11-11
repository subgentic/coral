// The rest of Walk 17's keyboard items (#15445, after #15296; Security's #15441 found them unchanged), failing first:
//  1. Send for review: Send comes before Cancel in Tab order, and Enter in the empty question does not close the dialog and say nothing: it stays, says why, and the focus stays in the box.
//  2. The sidebar's More actions menu (the Orchestrator's decision B on #15445): Tab and Shift+Tab close it and the focus goes on from its button, not to the next item with the menu left open.
//  3. The member editor (Edit member in the New team wizard): every checkbox a person can reach has a name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `kbdrest-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const problems = [];
    const key = async (k, code, vk, modifiers = 0) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(k === 'Enter' ? { text: '\r' } : {}) }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }); await settle(150); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev); await installNT(ev); await stubModels(ev);

        // 1. the Send for review question
        await ev(`window.__q = 'pending'; import(${S} + 'artifact_send_review.js').then(m => m.askReviewQuestion({ count: 1, name: 'plan.txt' }).then(v => { window.__q = v; })); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] input')`, 'the question dialog', 8000);
        const buttons = await ev(`[...document.querySelectorAll('dialog.send-review-dialog[open] button')].map(b => b.textContent)`);
        if (buttons.join() !== 'Send for review,Cancel') problems.push('Send for review comes before Cancel in Tab order: ' + buttons.join());
        await key('Enter', 'Enter', 13);
        const afterEmpty = await ev(`({ open: !!document.querySelector('dialog.send-review-dialog[open]'), q: window.__q, focus: document.activeElement && document.activeElement.id, said: (document.querySelector('dialog.send-review-dialog [role=status]') || {}).textContent || '' })`);
        if (!afterEmpty.open || afterEmpty.q !== 'pending') problems.push('Enter in the empty question closed the dialog: ' + JSON.stringify(afterEmpty));
        if (afterEmpty.open && !/question/i.test(afterEmpty.said)) problems.push('Enter in the empty question says nothing: ' + JSON.stringify(afterEmpty.said));
        if (afterEmpty.open && afterEmpty.focus !== 'send-review-question') problems.push('the focus left the question box: ' + afterEmpty.focus);
        await ev(`(document.querySelector('dialog.send-review-dialog[open] input') || { focus() {} }).focus(); true`);
        if (afterEmpty.open) { await client.Input.insertText({ text: 'Approve this?' }); await key('Enter', 'Enter', 13); await waitFor(`window.__q === 'Approve this?'`, 'Enter with a question sends it', 4000).catch(() => problems.push('Enter with a question did not send it')); }

        // 2. the member editor
        await openNewTeam(ev, waitFor);
        await T(ev, waitFor).to(2, {});
        await ev(`document.querySelector('#team-agents-list .team-agent-edit-btn').click(); true`); await settle(500);
        const checks = await ev(`(() => { const A = window.__na; return [...document.querySelectorAll('input[type=checkbox]')].filter(i => !i.disabled && i.tabIndex >= 0 && i.checkVisibility({ visibilityProperty: true })).map(i => ({ name: A.name(i).slice(0, 50), size: Math.round(i.getBoundingClientRect().width) })); })()`);
        for (const c of checks) if (!c.name || /^(on|off)$/i.test(c.name.trim()) || !c.size) problems.push('a checkbox in the member editor has no name or no size: ' + JSON.stringify(c));


        // 2. the sidebar's More actions menu: Tab and Shift+Tab close it and go on from its button
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(400);
        const toggleSel = await ev(`(() => { const A = window.__na; const t = [...document.querySelectorAll('aside [aria-haspopup="menu"][aria-controls]')].filter(A.vis).find(x => /^More actions for Orchestrator/.test(A.name(x))); if (!t) return null; t.id = t.id || 'kbd-menu-toggle'; return '#' + t.id; })()`);
        assert.ok(toggleSel, 'the sidebar has a More actions button');
        const MENU = `document.getElementById(document.querySelector(${JSON.stringify(toggleSel)}).getAttribute('aria-controls'))`;
        for (const [name, modifiers] of [['Tab', 0], ['Shift+Tab', 8]]) {
            await ev(`window.closeSidebarKebabs(); document.querySelector(${JSON.stringify(toggleSel)}).focus(); true`); // a menu an earlier step left open does not hide the next step
            await key('Enter', 'Enter', 13);
            await waitFor(`(() => { const m = ${MENU}; return m.style.display !== 'none' && m.contains(document.activeElement); })()`, name + ': the menu is open with the focus on an item', 4000);
            await ev(`import((window.__coralStatic || '/static/') + 'import_once.js').then(m => m.importOnce('./kebab_keys.js')).then(() => true)`); // the menu's keys load on its first opening: wait for them before pressing any
            const expected = await ev(`(() => { const t = document.querySelector(${JSON.stringify(toggleSel)}), menu = ${MENU};
                const tab = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter(e => !e.disabled && e.tabIndex >= 0 && e.getClientRects().length && !menu.contains(e));
                const n = tab[tab.indexOf(t) + ${modifiers ? -1 : 1}]; return n ? (n.id || n.getAttribute('aria-label') || n.textContent.trim().slice(0, 40)) : null; })()`);
            await key('Tab', 'Tab', 9, modifiers);
            const got = await ev(`(() => { const a = document.activeElement, m = ${MENU}; return { open: m.style.display !== 'none', at: a === document.body ? 'body' : (a.id || a.getAttribute('aria-label') || a.textContent.trim().slice(0, 40)) }; })()`);
            if (got.open) problems.push(name + ' left the menu open');
            if (got.at !== expected) problems.push(`${name} from a menu item went to ${JSON.stringify(got.at)}, not on from the menu's button (${JSON.stringify(expected)})`);
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('keyboard_walk17_rest_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
