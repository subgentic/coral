// A toast never covers the launch notice's buttons (#14825, Backend Dev on #14786): after a failed acknowledgement write the error toast stays for seconds, and on a phone at 200% text it sat over the notice's
// "I've read this" and Dismiss. The notices column starts below the notice (placeNotices), the same rule as the answer card (#14818), and follows the notice when it changes size. 390 px at 200% text (and 1280 px, where the
// column is at the bottom right and must stay clear of it too), a stubbed failing write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, big, view] of [[390, 844, true, true, ''], [390, 844, true, true, 'automations'], [390, 844, true, true, 'settings'], [390, 844, true, true, 'analytics'], [390, 844, true, false, ''], [1280, 800, false, false, '']]) {
            const at = `${w} px${big ? ' at 200% text' : ''}${view ? ', ' + view : ''}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            if (big) await ev(`document.documentElement.style.fontSize = '32px'; true`);
            if (view) await ev(`window.switchNavTab(${JSON.stringify(view)}); true`); await ev(framesJs(4));
            await ev(`fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`); // the notice is unseen
            await ev(`import(${S} + 'launch_disclosure.js').then(m => m.refreshLaunchDisclosure())`);
            await waitFor(`!!document.getElementById('launch-disclosure-banner')`, `${at}the unseen notice`, 10000);
            await ev(`document.querySelector('#launch-disclosure-banner details').open = true; true`); // read open: its "I've read this" is in the body, the button an acknowledgement is sent from
            await ev(framesJs(3));
            // a failed write: an error toast (what showToast(error.message, true) draws), and a second one
            await ev(`import(${S} + 'notifications.js').then(m => { m.showToast('Could not save that: the server did not answer.', true); m.showToast('Could not save that either.', true); return true; })`);
            await waitFor(`document.querySelectorAll('#toast-host > .toast').length >= 1`, `${at}the error toast`, 5000);
            await ev(framesJs(6));
            const g = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
                const notice = document.getElementById('launch-disclosure-banner');
                return { buttons: [...notice.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => ({ name: (b.getAttribute('aria-label') || b.textContent).trim(), ...r(b) })), toasts: [...document.querySelectorAll('#toast-host > .toast')].filter(t => t.getClientRects().length).map(r), notice: r(notice) }; })()`);
            check(g.buttons.length >= 1 && g.toasts.length >= 1, `${at}the notice's buttons and a toast are on screen: ${JSON.stringify(g)}`);
            // the notice is capped at 25dvh and scrolls inside itself (layout.css), so at 200% text the longer headline (#15079) leaves a button partly or wholly below the notice's own box: only the part inside that box is on screen, and a toast under the box covers none of it
            const shown = g.buttons.map(b => ({ ...b, t: Math.max(b.t, g.notice.t), b: Math.min(b.b, g.notice.b) })).filter(b => b.b > b.t);
            const covered = shown.filter(b => g.toasts.some(t => t.l < b.r && t.r > b.l && t.t < b.b && t.b > b.t));
            check(covered.length === 0, `${at}no toast covers the notice's buttons: ${JSON.stringify(covered)} under ${JSON.stringify(g.toasts)}`);
            await shot(`launch-notice-toast-${w}${big ? '-200' : ''}${view ? '-' + view : ''}`);
            await ev(`document.documentElement.style.fontSize = ''; document.querySelectorAll('#toast-host > .toast').forEach(t => t.remove()); true`);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('launch_notice_toast_clear_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
