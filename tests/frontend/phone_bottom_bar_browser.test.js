// The phone's bottom tab bar (#11472, the operator's Gmail reference): at 390 px a bar is docked at the bottom of the high-level screens (not floating, full width, 44 px or taller targets): four labelled
// tabs, Inbox, Agents, Tasks and Chats, the current one in a pill, the Inbox's waiting count on its icon; no More slot; a screen that is dug into (an agent's conversation) has none; the + sits above it.
// Wider than a phone there is none. Through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('bar-a', 'A', 3, { sleeping: false, display_name: 'Ada' }); true`);
        await waitFor(`window._coralGetLiveSessions().some(r => r.session_id === 'bar-a-id')`, 'the agent row', 8000);
        const bar = () => ev(`(() => { const n = document.getElementById('phone-nav'), cs = getComputedStyle(n), b = n.getBoundingClientRect(); const slots = [...n.querySelectorAll('.phone-nav-slot')];
            return { shown: cs.display !== 'none' && b.height > 0, pos: cs.position, l: Math.round(b.left), r: Math.round(b.right), bottom: Math.round(b.bottom), h: Math.round(b.height), labels: slots.map(s => s.querySelector('.phone-nav-label').textContent), small: slots.filter(s => s.getBoundingClientRect().height < 44 || s.getBoundingClientRect().width < 44).length,
                on: (n.querySelector('.phone-nav-slot.active') || {}).dataset ? n.querySelector('.phone-nav-slot.active').dataset.phoneNav : null, pill: n.querySelector('.phone-nav-slot.active .phone-nav-icon') ? getComputedStyle(n.querySelector('.phone-nav-slot.active .phone-nav-icon')).backgroundColor : '', more: n.querySelectorAll('[data-phone-nav=nav-more]').length }; })()`);
        let b = await bar();
        check(b.shown && b.pos === 'fixed' && b.l === 0 && b.r === 390 && b.bottom === 844 && b.h >= 72, 'the bar is docked at the bottom, full width: ' + JSON.stringify(b));
        check(JSON.stringify(b.labels) === JSON.stringify(['Agents', 'Inbox', 'Automations', 'Analytics']) && b.more === 0, 'four labelled tabs and no More slot: ' + JSON.stringify(b.labels));
        check(b.small === 0, 'every tab is a 44 px target');
        const polish = await ev(`(() => ({ icons: [...document.querySelectorAll('.phone-nav-slot svg')].map(s => s.innerHTML), badge: !!document.querySelector('[data-phone-nav="nav-inbox"] #phone-nav-inbox-badge'), noTasksChats: document.querySelectorAll('[data-phone-nav="nav-tasks"], [data-phone-nav="nav-chats"]').length === 0, menu: document.getElementById('nav-more-menu').getAttribute('aria-label') }))()`); // #11519, #11535
        check(new Set(polish.icons).size === 4 && polish.icons.every(i => !/<rect/.test(i)), 'the four tabs draw four different icons, none the stacked bars Computers uses: ' + JSON.stringify(polish.icons));
        check(polish.badge && polish.noTasksChats, 'the Needs you badge is on Inbox, and Tasks and Chats are not tabs (#11535): ' + JSON.stringify({ badge: polish.badge, none: polish.noTasksChats }));
        check(polish.menu === 'Navigation', 'the drawer is named Navigation for a screen reader, not Views: ' + polish.menu);
        check(b.on === 'nav-agents' && b.pill !== 'rgba(0, 0, 0, 0)', 'the current tab (Agents) is in a pill: ' + JSON.stringify({ on: b.on, pill: b.pill }));
        const fab = await ev(`(() => { const f = document.getElementById('phone-fab'), n = document.getElementById('phone-nav'); return f.getBoundingClientRect().bottom <= n.getBoundingClientRect().top; })()`);
        check(fab, 'the + sits above the bar');
        // each tab goes where it says, and is the one that is on
        for (const [slot, page] of [['nav-automations', 'Automations'], ['nav-analytics', 'Analytics'], ['nav-inbox', 'Needs you'], ['nav-agents', 'Agents']]) {
            await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=${slot}]').click(); true`);
            await waitFor(`document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav === '${slot}'`, `${page}: its tab is lit`, 8000);
        }
        // Tasks and Chats are the drawer's first rows on every screen (#11535), and a tap opens the page
        await ev(`[...document.querySelectorAll('.phone-menu-btn')].find(b => b.getClientRects().length).click(); true`);
        await waitFor(`!!document.querySelector('#nav-more-menu.nav-drawer:not([hidden]) .nav-drawer-folder')`, 'the drawer opens on Agents', 6000);
        const rowsIn = await ev(`[...document.querySelectorAll('#nav-more-menu .nav-drawer-folder .nav-drawer-label')].map(e => e.textContent)`);
        check(rowsIn.includes('Tasks') && rowsIn.includes('Chats'), 'the drawer has Tasks and Chats: ' + JSON.stringify(rowsIn));
        await ev(`document.getElementById('nav-drawer-scrim').click(); true`);
        // dug into an agent's conversation: no bar
        await ev(`window.selectLiveSession('bar-a', 'claude', 'bar-a-id', 'local'); true`);
        await coralReady(ev, 'agentSelected', 'bar-a-id');
        b = await ev(`getComputedStyle(document.getElementById('phone-nav')).display`);
        check(b === 'none', 'an agent\'s conversation has no bottom bar: ' + b);
        // wider than a phone: none
        await Emulation.setDeviceMetricsOverride({ width: 700, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor(`getComputedStyle(document.getElementById('phone-nav')).display === 'none'`, '700 px: no bar', 6000);
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the phone has a docked bottom bar of four tabs on its high-level screens');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
