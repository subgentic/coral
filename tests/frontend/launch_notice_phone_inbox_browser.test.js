// The launch notice on a phone's Inbox (#16460): it is in the pane, under the pane's own "Needs you" heading (right after .inbox-folder-toolbar) and above the list, as ONE element that
// moves: on any other tab it is the global strip under the top bar (unchanged), and a computer-width Inbox keeps the strip. On a COLD phone load of /inbox the room is reserved in the pane
// (theme_init.js), so the list under the heading stays put while the notice arrives (within 3 px: a typical height, not the exact one), and the page's .layout reserves nothing. 390 and 1280 px.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

const HOLD = `(() => { const f = window.fetch; window.fetch = (u, o) => /\\/api\\/launch-disclosure(\\?|$)/.test(String((u && u.url) || u)) && (!o || !o.method || o.method === 'GET') ? new Promise(r => setTimeout(r, 700)).then(() => f(u, o)) : f(u, o); })()`; // sleep-ok: the notice's read is held on purpose, so it lands after first paint
// the first thing under the pane's heading that is not the notice: its top at every frame, and when the notice is on screen
const TRACK = `(() => { const t = window.__jump = { tops: [], noticeAt: -1 };
    const tick = () => { const v = document.getElementById('group-table-view'), n = document.getElementById('launch-disclosure-banner'), bar = v && v.querySelector(':scope > .inbox-folder-toolbar');
        const below = bar && [...v.children].find(e => e !== bar && e !== n && e.getBoundingClientRect().height > 0 && !e.classList.contains('skip-link'));
        if (below) { t.tops.push(Math.round((below.getBoundingClientRect().top - bar.getBoundingClientRect().bottom) * 10) / 10); if (n && t.noticeAt < 0 && n.getBoundingClientRect().height > 0) t.noticeAt = t.tops.length; }
        if (t.noticeAt < 0 || t.tops.length < t.noticeAt + 3) requestAnimationFrame(tick); /* raf-ok: the tracker samples every frame itself, in the page, from the first one */ };
    requestAnimationFrame(tick); /* raf-ok: as above */ })();`;

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const where = () => ev(`(() => { const n = document.getElementById('launch-disclosure-banner'); if (!n) return { none: true }; const p = n.parentElement, prev = n.previousElementSibling; return { inPane: p && p.id === 'group-table-view', underHeading: !!prev && prev.classList.contains('inbox-folder-toolbar'), underBar: !!prev && (prev.id === 'local-auth-banner' || prev.matches('header.top-bar')), count: document.querySelectorAll('#launch-disclosure-banner').length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`);
            await ev(`try { localStorage.removeItem('coral-launch-notice'); } catch (e) {} true`);
            // 1. a cold load of /inbox/needs with the notice unseen and its read held
            const ids = [(await Page.addScriptToEvaluateOnNewDocument({ source: HOLD })).identifier];
            if (mobile) ids.push((await Page.addScriptToEvaluateOnNewDocument({ source: TRACK })).identifier);
            await Page.navigate({ url: BASE + '/inbox/needs' }); await Page.loadEventFired(); await install();
            check(await ev(`document.documentElement.hasAttribute('data-launch-notice')`), `${at}the room is reserved before first paint on a cold load of /inbox/needs`);
            await waitFor(`!!document.getElementById('launch-disclosure-banner') && (window.__jump ? window.__jump.noticeAt >= 0 && window.__jump.tops.length >= window.__jump.noticeAt + 3 : true)`, `${at}the notice on a cold load of /inbox/needs`, 15000);
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'hub-inbox' && !!document.querySelector('#group-table-view > .inbox-folder-toolbar')`, `${at}the Inbox's heading`, 10000);
            if (mobile && process.env.CORAL_SCREENSHOT_DIR) for (const theme of ['dark', 'light']) { // the shots: the phone's Inbox with the notice, both themes
                await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
                await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`); // raf-ok: two frames for the theme to paint
                fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/launch-notice-inbox-390-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            }
            let p = await where();
            if (mobile) {
                check(p.count === 1 && p.inPane && p.underHeading, `${at}on a phone's Inbox the notice is in the pane, right under the heading: ${JSON.stringify(p)}`);
                const j = await ev(`window.__jump`), spread = Math.max(...j.tops) - Math.min(...j.tops);
                check(j.noticeAt >= 1 && spread <= 3, `${at}the list under the heading stays put on a COLD phone load while the notice arrives (it moved ${spread} px over ${j.tops.length} frames: ${JSON.stringify([...new Set(j.tops)])})`);
                check(await ev(`getComputedStyle(document.querySelector('.layout')).marginTop === '0px'`), `${at}the page's .layout reserves nothing on a phone's Inbox (the room is in the pane)`);
                check(await ev(`!document.getElementById('launch-notice-room')`), `${at}the room is given back once the notice is drawn`);
            } else check(p.count === 1 && p.underBar, `${at}a computer-width Inbox keeps the strip under the top bar: ${JSON.stringify(p)}`);
            for (const id of ids) await Page.removeScriptToEvaluateOnNewDocument({ identifier: id });
            // 2. the same element moves with the tab, and comes back when the pane is redrawn
            await ev(`window.switchNavTab('agents'); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'agents'`, `${at}the Agents tab`, 8000);
            p = await where(); check(p.count === 1 && p.underBar, `${at}on another tab the notice is the strip under the top bar: ${JSON.stringify(p)}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('#group-table-view > .inbox-folder-toolbar')`, `${at}the Inbox again`, 8000);
            await waitFor(`(() => { const n = document.getElementById('launch-disclosure-banner'); return !!n && ${mobile ? `n.parentElement.id === 'group-table-view'` : `n.parentElement === document.body`}; })()`, `${at}the notice is where this screen puts it, back on the Inbox`, 8000);
            if (mobile) {
                await ev(`(() => { const v = document.getElementById('group-table-view'); const bar = v.querySelector(':scope > .inbox-folder-toolbar'); bar.replaceWith(bar.cloneNode(true)); return true; })()`); // a redraw drops what is in the pane
                await waitFor(`(() => { const n = document.getElementById('launch-disclosure-banner'); return !!n && n.previousElementSibling && n.previousElementSibling.classList.contains('inbox-folder-toolbar') && n.parentElement.id === 'group-table-view'; })()`, `${at}after a redraw of the heading the notice is under it again`, 8000);
                check((await where()).count === 1, `${at}still one notice after the redraw`);
            }
            // 3. dismissed: gone from wherever it is
            await ev(`document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click(); true`);
            await waitFor(`!document.getElementById('launch-disclosure-banner')`, `${at}the notice dismissed`, 8000);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('launch_notice_phone_inbox_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
