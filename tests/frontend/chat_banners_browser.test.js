// The two banners above the chat (#16367, Beta Tester's chat walk #16341): (1) the auto-mode notice says "Agents default to auto mode" only while the saved default is Auto (unset is Auto): with Accept edits
// saved it is hidden at once (no reload), and it is back when the default returns to Auto; (2) the notice and the alerts offer dismiss with the same quiet x (a 44 px target on touch), the notice keeps its
// "I've read this"; (3) the alerts offer is ONE 44 px row at 1280 and 390 px, so the two together take little of the screen, and a scrolled page keeps what it was showing when the offer arrives.
// 1280 and 390 px. Shots (light and dark) go to CORAL_SCREENSHOT_DIR when it is set.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const shotDir = process.env.CORAL_SCREENSHOT_DIR;
    const snap = async name => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); fs.writeFileSync(`${shotDir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const notice = `document.getElementById('launch-disclosure-banner')`;
    const refresh = () => ev(`import((window.__coralStatic || '/static/') + 'launch_disclosure.js').then(m => m.refreshLaunchDisclosure()).then(() => true)`);
    const setDefault = async value => { // through the real Settings control, so the save path that follows is the page's own
        await ev(`window.showSettingsModal(); true`); await waitFor(`!!document.getElementById('settings-permission-mode')`, 'Settings open', 10000);
        await waitFor(`(() => { const s = document.getElementById('settings-permission-mode'), d = (window.T.state.settings || {}).default_permission_mode || ''; return s.value === d || (d === 'auto' && s.value === ''); })()`, 'the control shows the saved default before it is changed', 10000); // the dialog fills the control a moment after it opens, and a change made before that is no change to the autosave
        await ev(`(() => { const s = document.getElementById('settings-permission-mode'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`(() => { const r = document.getElementById('settings-permission-mode').closest('.sv-row'); return !!r && !r.querySelector('[data-error]') && !document.getElementById('settings-permission-mode').disabled; })()`, 'the default saved', 10000);
        await ev(`window.hideSettingsModal(true); true`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            // 1. the notice follows the saved default
            await ev(`localStorage.removeItem('coral-launch-notice'); fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`);
            await setDefault('auto'); await refresh();
            await waitFor(`!!${notice}`, `${at}the notice with Auto as the default`, 10000);
            await setDefault('acceptEdits');
            await waitFor(`!${notice}`, `${at}the notice is gone once Accept edits is the saved default (no reload)`, 10000);
            await refresh();
            check(await ev(`!${notice}`), `${at}a refresh with Accept edits saved still shows no notice`);
            await setDefault('auto');
            await waitFor(`!!${notice}`, `${at}the notice is back when the default returns to Auto (saved default ${JSON.stringify(await ev('(window.T && window.T.state && window.T.state.settings || {}).default_permission_mode'))})`, 10000).catch(async e => { throw new Error(e.message + ' | server ' + JSON.stringify(await ev(`fetch('/api/settings').then(r => r.json()).then(s => [s.settings && s.settings.default_permission_mode, document.getElementById('settings-permission-mode') && document.getElementById('settings-permission-mode').value])`))); });
            // 2 and 3. both banners, and the offer's row
            await ev(`(() => { if (typeof Notification === 'undefined') window.Notification = class { static get permission() { return 'default'; } static requestPermission() { return Promise.resolve('default'); } }; localStorage.removeItem('coral-alerts-offered'); localStorage.removeItem('coral-desktop-notify'); return true; })()`);
            const before = await ev(`(() => { const c = [...document.body.children].find(e => e.tagName === 'DIV' && !e.id && e.getBoundingClientRect().height > 100); return Math.round(c.getBoundingClientRect().top); })()`);
            const offered = await ev(`import((window.__coralStatic || '/static/') + 'alerts_offer.js').then(m => m.offerAlertsAfterLaunch())`);
            check(offered === true, `${at}the alerts offer is shown for the check (${offered})`);
            await waitFor(`!!document.getElementById('alerts-offer-banner') && document.getElementById('alerts-offer-banner').getBoundingClientRect().height > 0`, `${at}the alerts offer`, 8000);
            await waitFor(`[...document.querySelectorAll('#alerts-offer-banner .btn')].every(b => getComputedStyle(b).marginTop === '0px' && b.getBoundingClientRect().height >= 44)`, `${at}the offer's buttons have settled (a button's own transition ends)`, 8000);
            const m = await ev(`(() => { const a = document.getElementById('alerts-offer-banner'), n = ${notice}, x = a.querySelector('.btn-icon'), d = n.querySelector('.launch-disclosure-dismiss'), rect = e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
                const read = [...n.querySelectorAll('button')].find(b => b.textContent.trim() === "I've read this");
                return { offer: rect(a), notice: rect(n), x: rect(x), d: rect(d), xClass: [...x.classList].filter(c => ['btn-quiet', 'btn-icon', 'btn-small'].includes(c)).sort().join(' '), dClass: [...d.classList].filter(c => ['btn-quiet', 'btn-icon', 'btn-small'].includes(c)).sort().join(' '), xText: x.textContent, dText: d.textContent, dLabel: d.getAttribute('aria-label'), hasRead: !!read, total: Math.round(a.getBoundingClientRect().height + n.getBoundingClientRect().height) }; })()`);
            check(m.offer.h <= 48, `${at}the alerts offer is one row (${m.offer.h} px tall, at most 48)`);
            check(m.xClass === m.dClass && m.xClass === 'btn-icon btn-quiet btn-small', `${at}both dismiss buttons are the same quiet icon button (offer: ${m.xClass}, notice: ${m.dClass})`);
            check(m.xText === '×' && m.dText === '×', `${at}both dismiss with an x (offer ${JSON.stringify(m.xText)}, notice ${JSON.stringify(m.dText)})`);
            check(m.dLabel === 'Dismiss, I have read this', `${at}the notice's x keeps its accessible name (${m.dLabel})`);
            check(m.hasRead, `${at}the notice keeps its "I've read this" button`);
            check(m.x.w >= 44 && m.x.h >= 44 && m.d.w >= 44 && m.d.h >= 44, `${at}both x buttons are 44 px targets (offer ${JSON.stringify(m.x)}, notice ${JSON.stringify(m.d)})`);
            check(m.total <= 104, `${at}the two banners take ${m.total} px together (at most 104: two 44 px rows and their borders)`);
            const after = await ev(`(() => { const c = [...document.body.children].find(e => e.tagName === 'DIV' && !e.id && e.getBoundingClientRect().height > 100); return Math.round(c.getBoundingClientRect().top); })()`);
            check(after - before <= m.total + 2, `${at}the page content moved ${after - before} px for banners that take ${m.total} px`);
            for (const theme of ['light', 'dark']) {
                await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'settings_core.js'); s.applyTheme('${theme}'); return true; })()`);
                await new Promise(r => setTimeout(r, 250)); // sleep-ok: the theme's repaint settles before a screenshot (nothing observable to wait on)
                await snap(`banners-${w}-${theme}`);
            }
            // the x of the offer removes it for good; the notice's records the read
            await ev(`document.querySelector('#alerts-offer-banner .btn-icon').click(); true`);
            check(await ev(`!document.getElementById('alerts-offer-banner')`), `${at}the offer's x removes the offer`);
            await ev(`document.querySelector('#launch-disclosure-banner .launch-disclosure-dismiss').click(); true`);
            await waitFor(`!${notice}`, `${at}the notice's x records the read and removes it`, 8000);
        }
    } finally { await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('chat_banners_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
