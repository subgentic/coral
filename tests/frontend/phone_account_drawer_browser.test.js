// The phone's account button opens the drawer AT the account entries (#12634, coral-hub's beta pass of the Hub): "Settings and account" opened the left drawer at its top, with the Inbox's folders and the teams, and Settings, Themes, the update
// check, Computers, the account's pages and Sign out sat at the bottom, off the screen. The ☰ keeps opening it at its top. On a short phone (390 x 560) so the drawer scrolls. Real taps (CDP touch). Drives Chrome against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const tap = async sel => { const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }); await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); };
    const state = () => ev(`(() => { const m = document.getElementById('nav-more-menu'); if (m.hidden) return { open: false }; const mr = m.getBoundingClientRect(), s = m.querySelector('[data-account-start], .nav-more-item'), items = [...m.querySelectorAll('.nav-more-item')].map(i => i.textContent.trim()), settings = [...m.querySelectorAll('.nav-more-item')].find(i => /Settings$/.test(i.textContent.trim())); const sr = settings && settings.getBoundingClientRect(); return { open: true, scrollTop: Math.round(m.scrollTop), scrolls: m.scrollHeight > m.clientHeight + 1, settingsVisible: !!sr && sr.top >= mr.top - 1 && sr.bottom <= mr.bottom + 1, last: items[items.length - 1], n: items.length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 560, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('.phone-account-btn') && document.querySelector('.phone-account-btn').getClientRects().length > 0`, 'the phone bar', 10000);

        await tap('.phone-account-btn');
        await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the drawer opens from the account button', 6000);
        await ev(framesJs(8));
        const a = await state();
        check('the drawer is long enough to scroll on a short phone (the check is only meaningful then)', a.scrolls, JSON.stringify(a));
        check('from the account button the drawer shows Settings, scrolled to the account entries', a.settingsVisible && a.scrollTop > 0, JSON.stringify(a));
        check('and the last entry (Sign out or the last of the list) is in reach', a.last && a.n > 5, JSON.stringify(a));

        await ev(`document.getElementById('nav-more-menu').hidden = true; document.querySelectorAll('[data-on-click="m-top-menu"]').forEach(b => b.setAttribute('aria-expanded', 'false')); document.querySelector('.nav-drawer-scrim')?.click(); true`);
        await ev(framesJs(6));
        await tap('.phone-menu-btn');
        await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the drawer opens from the ☰', 6000);
        await ev(framesJs(8));
        const m = await state();
        check('from the ☰ the drawer opens at its top', m.scrollTop === 0, JSON.stringify(m));
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('phone_account_drawer_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
