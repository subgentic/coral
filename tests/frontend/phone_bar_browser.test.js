// The phone's ONE top bar (#11236, the operator's reference: the agent list's bar; phone_bar.js): every top-level view draws the same bar as Home: ☰ on its own at the left (44 px, outside the pill), a borderless filled fully rounded
// pill in the middle (48 px: Home's search, every other view's title), the account avatar at the right (44 px). The suite measures the bar's boxes and the pill's style in each view and fails if any differs from Home's; the pill is a
// heading with no title attribute and nothing above it carries one (no tooltip lands on it); a drill-down draws no ☰ and no avatar. 390 px and a narrow desktop window (500 px), 100% and 200% text, light and dark.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev), { coralReady } = require('./helpers/wait');
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const measure = () => ev(`(() => { const vis = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const bar = [...document.querySelectorAll('.phone-bar')].find(vis); if (!bar) return null;
        const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
        const menu = bar.querySelector('.phone-menu-btn'), pill = bar.querySelector('.phone-bar-pill'), acct = bar.querySelector('.phone-account-btn'), look = pill.matches('.mobile-search-row') ? pill.querySelector('input') : pill, cs = getComputedStyle(look), bt = bar.getBoundingClientRect().top;
        let titled = !!pill.getAttribute('title'); for (let p = pill; p && p !== document.body; p = p.parentElement) if (p.hasAttribute('title')) titled = true;
        const m = r(menu), pl = r(look), a = r(acct);
        return { menu: { l: m.l - Math.round(bar.getBoundingClientRect().left), y: m.t - Math.round(bt), w: m.w, h: m.h }, pill: { y: pl.t - Math.round(bt), h: pl.h, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, border: cs.borderTopWidth, fs: cs.fontSize, inside: pl.l >= m.l + m.w - 2 && pl.l + pl.w <= a.l + 2 }, acct: { right: Math.round(bar.getBoundingClientRect().right - (a.l + a.w)), y: a.t - Math.round(bt), w: a.w, h: a.h }, titled, text: pill.textContent.trim().slice(0, 30) }; })()`);
    const VIEWS = [['agents', 'Home'], ['hub-inbox', 'Inbox'], ['automations', 'Automations'], ['docs', 'Docs'], ['servers', 'Computers']];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'dark'], [390, 16, 'light'], [390, 32, 'dark'], [500, 16, 'dark']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            const got = {};
            for (const [tab, name] of VIEWS) {
                await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`); await settle(500);
                if (tab === 'servers' && !(await measure())) continue; // a Coral with no Computers page
                got[name] = await measure();
                await shot(`phone-bar-${w}-${fs}-${theme}-${name}`);
            }
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { window.switchNavTab('tokens'); return true; })`); await settle(700);
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.phoneBack(); return true; })`); await settle(400);
            got.Analytics = await measure(); await shot(`phone-bar-${w}-${fs}-${theme}-Analytics`);
            const tag = `${w}@${fs} ${theme}`, home = got.Home;
            assert.ok(home && home.pill.h === 48 && home.menu.w === 44 && home.acct.w === 44 && home.pill.border === '0px' && home.pill.inside, `${tag}: Home's bar is the reference (48 px pill, 44 px ☰ and avatar, no border): ` + JSON.stringify(home));
            for (const [name, g] of Object.entries(got)) {
                assert.ok(g, `${tag}: ${name} draws the bar`);
                assert.deepEqual({ ...g, text: 0, titled: 0 }, { ...home, text: 0, titled: 0 }, `${tag}: ${name}'s bar is Home's bar (boxes, pill style, avatar): ${JSON.stringify(g)} vs ${JSON.stringify(home)}`);
                assert.ok(!g.titled && (name === 'Home' || g.text.length > 0), `${tag}: ${name}'s pill has its title in it and no title attribute (no tooltip) above it: ` + JSON.stringify(g));
            }
        }
        // a window between 601 and 767 px keeps its own layout, but Home's search is in the bar's pill and must still be there (the list is the page up to 767 px): visible, with no ☰ or avatar drawn
        await Emulation.setDeviceMetricsOverride({ width: 700, height: 844, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await settle(500);
        const wide = await ev(`(() => { const i = document.querySelector('#mobile-agent-list .mobile-search-input'), m = document.querySelector('#mobile-agent-list .phone-menu-btn'), a = document.querySelector('#mobile-agent-list .phone-account-btn'); return { search: !!i && i.getBoundingClientRect().width > 100, menu: !!m && m.getClientRects().length > 0, account: !!a && a.getClientRects().length > 0 }; })()`);
        assert.deepEqual(wide, { search: true, menu: false, account: false }, 'at 700 px Home has its search and no phone ☰ or avatar: ' + JSON.stringify(wide));
        // a new Coral's Home on a short phone (the Mobile Beta Tester's walk, item 6): its last card, Open folder, can be scrolled to and ends above the floating nav, not under it
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 640, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await settle(600);
        const end = await ev(`(() => { const list = document.getElementById('mobile-agent-list'); list.scrollTop = list.scrollHeight; const card = [...list.querySelectorAll('button, a, [role=button], .welcome-launch')].filter(e => e.getClientRects().length && /Open folder/.test(e.textContent)).pop(); const nav = document.getElementById('phone-nav'); if (!card) return null; return { cardBottom: Math.round(card.getBoundingClientRect().bottom), navTop: getComputedStyle(nav).display === 'none' ? 9999 : Math.round(nav.getBoundingClientRect().top) }; })()`);
        assert.ok(end && end.cardBottom <= end.navTop, 'the Open folder card scrolls to above the bottom nav: ' + JSON.stringify(end));
        // a drill-down is not this bar: no ☰ and no avatar
        await ev(`window.switchNavTab('tokens'); true`); await settle(700);
        assert.equal(await ev(`[...document.querySelectorAll('.phone-bar')].filter(b => b.getClientRects().length > 0).length`), 0, 'a drill-down (an Analytics view) draws neither ☰ nor the avatar');
        console.log('PASS the phone bar: one bar in every top-level view');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
