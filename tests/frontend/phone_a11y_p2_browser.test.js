// The phone's accessibility P2s from slice A (#11281, from #11260, #11270 and the accessibility pass): at 390 and 320 px, 100% and 200% text, light and dark:
//  - the Inbox's and Automations' strip is a real tab list: role=tablist, each view a role=tab with aria-selected (one true), aria-controls the page's tabpanel, which is named by the open tab; one Tab stop (roving), Left/Right move the focus
//    and Enter opens the tab it is on;
//  - the bottom nav is a landmark named Main and its four buttons say Inbox page, Agents page, Tasks page and Chats page (#11472: the bar is Gmail's; no control shares a name with the drawer's entries);
//  - the Home list's per-row and per-team ⋯ is a 44 px button;
//  - on a desktop width the view list is a plain column (no tab roles).
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const open = async (w, fs, theme) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`for (const n of ['Ada', 'Bo', 'Cy', 'Di']) window.__m.add(n, 'A', 2, { sleeping: false, session_id: n + '-id', board_project: 'team-a' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).length >= 4`, 'the agents', 10000);
        await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'), r = await import((window.__coralStatic || '/static/') + 'render.js'); r.renderLiveSessions(s.state.liveSessions); return true; })()`);
        await waitFor(` getComputedStyle(document.getElementById('phone-nav')).display !== 'none' && document.querySelectorAll('#mobile-session-list .session-group-item').length >= 1 && getComputedStyle(document.getElementById('phone-fab')).display !== 'none'`, 'the home, its card, the nav and the +', 10000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await ev(`({ cards: document.querySelectorAll('#mobile-session-list .session-group-item').length, fab: getComputedStyle(document.getElementById('phone-fab')).display, body: document.body.className, nav: getComputedStyle(document.getElementById('phone-nav')).display, empty: !!document.querySelector('#mobile-agent-list .empty-launch') })`))); });
        await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
    };
    const press = async (k, vk) => { await Input.dispatchKeyEvent({ type: k === 'Enter' ? 'keyDown' : 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }); await new Promise(r => setTimeout(r, 250)); }; // sleep-ok: the strip's focus and the page's redraw settle over a frame or two
    const tabs = () => ev(`(() => { const nav = document.querySelector('#group-table-view .view-list-nav'); const t = [...nav.querySelectorAll('[role=tab]')]; const sel = t.filter(b => b.getAttribute('aria-selected') === 'true');
        const panel = document.getElementById((t[0] && t[0].getAttribute('aria-controls')) || '');
        return { role: nav.getAttribute('role'), label: nav.getAttribute('aria-label'), n: t.length, all: document.querySelectorAll('#group-table-view .view-list-item').length, selected: sel.map(b => b.dataset.key), current: nav.querySelector('[aria-current=true]')?.dataset.key || null, stops: t.filter(b => b.tabIndex === 0).length, controls: [...new Set(t.map(b => b.getAttribute('aria-controls')))],
            panelRole: panel && panel.getAttribute('role'), panelLabelledby: panel && panel.getAttribute('aria-labelledby'), selectedId: sel[0] && sel[0].id, panelHasTable: !!panel && !!panel.querySelector('table, .dt-mail, .group-table-node, [class*=table]'), panelHoldsStrip: !!panel && panel.contains(nav), focus: document.activeElement.dataset.key || null, active: document.activeElement.tagName + '.' + document.activeElement.className.toString().slice(0, 40) }; })()`);
    const probe = async (what, tag) => {
        const a = await tabs();
        assert.equal(a.role, 'tablist', `${tag} ${what}: the strip is a tablist: ${JSON.stringify(a)}`);
        assert.ok(a.n >= 2 && a.n === a.all, `${tag} ${what}: every view is a tab (${a.n} of ${a.all})`);
        assert.deepEqual(a.selected, [a.current], `${tag} ${what}: exactly one tab is selected and it is the open one: ${JSON.stringify(a)}`);
        assert.equal(a.stops, 1, `${tag} ${what}: one Tab stop`);
        assert.equal(a.controls.length, 1, `${tag} ${what}: the tabs control one panel: ${JSON.stringify(a.controls)}`);
        assert.ok(a.panelRole === 'tabpanel' && a.panelLabelledby === a.selectedId && !a.panelHoldsStrip, `${tag} ${what}: the panel is a tabpanel named by the open tab and does not hold the strip: ${JSON.stringify(a)}`);
        // Right moves the focus to the next tab and leaves the open one; Enter opens it
        // the page redraws as the lists settle: the focus is put on the open tab until it stays there
        // the page redraws as the lists settle, and under load that can come between the focus and the key and take the focus away (red 6 of 6 at 4x CPU throttle): wait until the view has stopped changing, then focus and press once
        await ev(`(() => { const root = document.getElementById('group-table-view'); window.__quiet = Date.now(); if (window.__quietObs) window.__quietObs.disconnect(); window.__quietObs = new MutationObserver(() => { window.__quiet = Date.now(); }); window.__quietObs.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); return true; })()`);
        await waitFor(`Date.now() - window.__quiet > 600`, `${tag} ${what}: the view has stopped redrawing`, 10000);
        let first = null;
        await waitFor(`(() => { const cur = document.querySelector('#group-table-view [role=tab][aria-selected=true]'); if (!cur) return false; cur.focus(); return document.activeElement === cur; })()`, `${tag} ${what}: the open tab takes the focus`, 8000);
        first = await ev(`document.activeElement.dataset.key`);
        await press('ArrowRight', 39);
        const b = await tabs();
        assert.ok(b.focus && b.focus !== first && b.selected[0] === first, `${tag} ${what}: Right moves the focus (${first} to ${b.focus}) and does not open it: ${JSON.stringify(b)}`);
        await press('Enter', 13);
        await waitFor(`document.querySelector('#group-table-view [role=tab][aria-selected=true]')?.dataset.key === ${JSON.stringify(b.focus)}`, `${tag} ${what}: Enter opens the tab`, 8000);
        const c = await tabs();
        assert.ok(c.panelRole === 'tabpanel' && c.panelLabelledby === c.selectedId && c.selected.length === 1, `${tag} ${what}: after Enter the panel is named by the new tab: ${JSON.stringify(c)}`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'light'], [390, 32, 'dark'], [320, 16, 'dark'], [320, 32, 'light']]) {
            await open(w, fs, theme);
            const tag = `${w}@${fs} ${theme}`;
            // the nav
            const nav = await ev(`({ label: document.getElementById('phone-nav').getAttribute('aria-label'), tag: document.getElementById('phone-nav').tagName, names: [...document.querySelectorAll('#phone-nav .phone-nav-slot')].map(b => b.getAttribute('aria-label')) })`);
            assert.deepEqual(nav, { label: 'Main', tag: 'NAV', names: ['Inbox page', 'Agents page', 'Tasks page', 'Chats page'] }, `${tag}: the nav is a landmark named Main and its buttons say Inbox page, Agents page, Tasks page, Chats page (none shares a name with the menu's items)`);
            // Home's ⋯: 44 px, each row and each team
            const k = await ev(`[...document.querySelectorAll('#mobile-session-list .sidebar-kebab-btn')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return [b.getAttribute('aria-label'), Math.round(r.width), Math.round(r.height)]; })`);
            assert.ok(k.length >= 2 && k.every(x => x[1] >= 44 && x[2] >= 44), `${tag}: Home's ⋯ buttons are 44 px: ${JSON.stringify(k)}`);
            // Inbox
            await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-inbox]').click(); true`);
            await waitFor(`!!document.querySelector('#group-table-view [role=tab]') && document.querySelector('#group-table-view [role=tab]').getClientRects().length > 0`, `${tag}: the Inbox strip`, 10000);
            await probe('Inbox', tag);
            // Automations
            await ev(`window.switchNavTab('automations'); true`);
            await waitFor(`!!document.querySelector('#group-table-view [role=tab]') && document.querySelector('#group-table-view [aria-label="Automations folders"]')`, `${tag}: the Automations strip`, 10000);
            await probe('Automations', tag);
        }
        // a desktop width: the same list is a column, not tabs
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('.view-list-item')`, 'the Inbox column', 10000);
        assert.equal(await ev(`document.querySelectorAll('.view-list [role=tab], .view-list [role=tablist]').length`), 0, 'a desktop width: the view list has no tab roles');
        console.log('PASS the phone strip is a tab list with a named panel, the nav says Inbox, Agents, Tasks, Chats pages in a landmark named Main, and Home\'s ⋯ is 44 px');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
