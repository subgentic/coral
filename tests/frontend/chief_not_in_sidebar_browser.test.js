// #15793 (the Operator: Chief is too prominent for something barely worked on): no Chief card in the Agents sidebar above New agent / New team, no reserved room for it, no Chief entry in the ☰ menu;
// Chief stays in Settings > Chief, which has a plain "Open Chief" link to /chief while the page is on. The two buttons have a real gap (8 px) and line up with the search box above (the sidebar's 12 px side padding).
// 1280 px, 960 px, 1280 px at 200% text, and the phone's menu at 390 px. Isolated dev server; the settings it changes are put back (guardSettings).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings();
    const problems = [];
    const dashboard = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, zoom] of [['1280 px', 1280, 900, ''], ['960 px', 960, 800, ''], ['1280 px at 200% text', 1280, 900, '200%']]) {
            await dashboard(w, h, false);
            if (zoom) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            await waitFor(`!!document.querySelector('.sidebar-footer .sidebar-new-btn-full') && document.querySelector('.sidebar-footer').getClientRects().length > 0`, `${label}: the sidebar footer is laid out`, 8000);
            const s = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height }; };
                const f = document.querySelector('.sidebar-footer'), btns = [...f.querySelectorAll('.sidebar-new-btn-full')].map(r), search = document.querySelector('.sidebar-header .sidebar-search'), head = document.querySelector('.sidebar-header'), side = document.querySelector('.sidebar'), pad = e => { const c = getComputedStyle(e); return [parseFloat(c.paddingLeft), parseFloat(c.paddingRight)]; };
                return { slot: !!document.getElementById('sidebar-chief-slot'), chiefLinks: side.querySelectorAll('a[href^="/chief"], .sidebar-chief-link').length, kids: [...f.children].map(c => c.tagName + '.' + c.className.split(' ')[0]), btns, foot: r(f), search: search ? r(search) : null, footPad: pad(f), headPad: pad(head), fs: parseFloat(getComputedStyle(document.documentElement).fontSize) }; })()`);
            const at = label + ': ';
            if (s.slot || s.chiefLinks) problems.push(`${at}no Chief card in the sidebar (slot ${s.slot}, links ${s.chiefLinks})`);
            if (s.btns.length !== 2 || s.kids.length !== 2) problems.push(`${at}the footer holds only New agent and New team: ${JSON.stringify(s.kids)}`);
            else {
                const gap = s.btns[1].l - s.btns[0].r;
                if (gap < 7.5 || gap > 12) problems.push(`${at}the two buttons have an 8 px gap (${gap})`);
                if (s.footPad[0] !== s.headPad[0] || s.footPad[1] !== s.headPad[1]) problems.push(`${at}the footer has the same side padding as the search box's header: ${JSON.stringify([s.footPad, s.headPad])}`);
                if (s.search && (Math.abs(s.btns[0].l - s.search.l) > 1.5 || Math.abs(s.btns[0].l - (s.foot.l + s.footPad[0])) > 1.5 || Math.abs(s.btns[1].r - (s.foot.r - s.footPad[1])) > 1.5)) problems.push(`${at}the buttons line up with the search box above and fill the footer: ${JSON.stringify([s.btns, s.search, s.foot])}`);
                if (!zoom && s.foot.h > 84) problems.push(`${at}no reserved room for Chief: the footer is ${s.foot.h} px tall`);
            }
        }
        await dashboard(390, 844, true);
        await ev(`document.getElementById('top-menu-btn')?.click(); true`);
        await waitFor(`(() => { const m = document.getElementById('nav-more-menu'); return !!m && !m.hidden && m.querySelectorAll('.nav-more-item').length > 0; })()`, 'the ☰ menu opens', 6000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the old entry joined the open menu a tick after its answer; nothing is awaited now, so wait out that tick
        const menu = await ev(`({ chief: document.querySelectorAll('#nav-more-menu [data-chief-entry]').length, text: [...document.querySelectorAll('#nav-more-menu .nav-more-item')].some(i => /Chief/.test(i.textContent)) })`);
        if (menu.chief || menu.text) problems.push('390 px: no Chief entry in the ☰ menu: ' + JSON.stringify(menu));
        await dashboard(1280, 900, false);
        await ev(`window.showSettingsModal('chief'); true`);
        await waitFor(`!!document.querySelector('a.chief-open-link')`, 'Settings > Chief is drawn', 8000);
        const off = await ev(`(() => { const a = document.querySelector('a.chief-open-link'); return a.getClientRects().length; })()`);
        if (off !== 0) problems.push('Settings > Chief: Open Chief is not shown while the Chief page is off');
        assert.equal(await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chief_page: 'true' }) }).then(r => r.status)`), 200);
        await dashboard(1280, 900, false);
        await ev(`window.showSettingsModal('chief'); true`);
        await waitFor(`(() => { const a = document.querySelector('a.chief-open-link'); return !!a && a.getClientRects().length > 0; })()`, 'Open Chief shows while the page is on', 8000).catch(() => problems.push('Settings > Chief: Open Chief is shown while the Chief page is on'));
        const link = await ev(`(() => { const a = document.querySelector('a.chief-open-link'); return a ? { href: a.getAttribute('href'), text: a.textContent.trim() } : null; })()`);
        if (!link || link.href !== '/chief' || link.text !== 'Open Chief') problems.push('Settings > Chief: a plain Open Chief link to /chief: ' + JSON.stringify(link));
    } finally { await guard.restore(); await client.close(); }
    assert.deepEqual(problems, [], 'Chief is not in the sidebar:\n  ' + problems.join('\n  '));
    console.log('PASS Chief is only in Settings > Chief; the sidebar buttons have a gap');
})().catch(e => { console.error(e); process.exit(1); });
