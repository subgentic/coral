// Dialog bodies use the height in landscape (Mobile pass 30, #10385, #10388): at 844 x 390 a dialog's header and footer took more than a third of the screen, leaving a body of two controls (Settings 214 px, the password dialog 193). The chrome
// (header and footer together) is at most 28% of the height in New agent step 2, Settings and Set a password; the dialogs' own contents are unchanged. A coarse pointer, 844 x 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width), bottom: Math.round(r.bottom) }; })()`);
    const open = async (h = 390) => {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 844, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.__m.add('coral-go', 'm', 8, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the chat', 10000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the page settles
    };
    try {
        await open();
        const parts = () => ev(`(() => { const m = [...document.querySelectorAll('.modal')].filter(e => e.getClientRects().length && getComputedStyle(e).display !== 'none').pop(); if (!m) return null; const h = sel => { const x = m.querySelector(sel); return x && x.getClientRects().length ? Math.round(x.getBoundingClientRect().height) : 0; }; return { id: m.id, header: h('.sd-step-header, .modal-header'), footer: h('.modal-footer, .modal-actions'), vh: innerHeight }; })()`);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c) c.click(); return true; })()`); await new Promise(r => setTimeout(r, 800)); // sleep-ok: the dialog draws
        await ev(`document.getElementById('launch-dir').value = '/tmp'; document.getElementById('launch-dir').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('launch-agent-next').click(); true`); await new Promise(r => setTimeout(r, 800)); // sleep-ok: step 2 draws
        let p = await parts(); check(p && p.header + p.footer <= 0.28 * p.vh, `New agent step 2: header and footer are at most 28% of the screen: ${JSON.stringify(p)}`);
        await ev(`window.hideLaunchModal(); window.showSettingsModal(); true`); await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the dialog fills
        p = await parts(); check(p && p.header + p.footer <= 0.28 * p.vh, `Settings: ${JSON.stringify(p)}`);
        await ev(`window.hideSettingsModal(); import(${S} + 'password_ui.js').then(m => m.showSetPasswordModal({ local: true })).then(() => true)`); await new Promise(r => setTimeout(r, 800)); // sleep-ok: the dialog draws
        p = await parts(); check(p && p.header + p.footer <= 0.28 * p.vh, `Set a password: ${JSON.stringify(p)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'dialogs:\n  ' + problems.join('\n  '));
    console.log('PASS dialogs');
})().catch(e => { console.error(e); process.exit(1); });
