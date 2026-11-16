// The Hub's Settings has no Providers section (#16813, QA Engineer 2 on #15878): the pane's rows are machine settings (default models, thinking, CLI paths) and are hidden in hub mode, but its four provider
// card titles were headings, not rows, so opening the section directly (a link, a remembered tab) showed Claude, Codex, Antigravity and Pi as bare titles. In hub mode its tab is not listed and nothing of the pane
// is drawn, even when it is asked for by name. 1280 and 390 px; hub mode is the page's own cloud-mode class plus applyCloudSettingsDialog, as hub_settings_layout does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
            await ev(`document.body.classList.add('cloud-mode'); (async () => { await window.showSettingsModal('general'); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings');
            await ev(`(async () => { (await import((window.__coralStatic || '/static/') + 'cloud_settings.js')).applyCloudSettingsDialog(); return true; })()`);
            const tab = () => ev(`(() => { const t = document.querySelector('#settings-modal [data-group="providers"]:not(.settings-pane)'); return t ? getComputedStyle(t).display !== 'none' && !t.hidden : false; })()`);
            assert.equal(await tab(), false, `${w}: the Providers section is not listed in hub mode`);
            await ev(`(async () => { await window.showSettingsModal('providers'); return true; })()`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the section is drawn over a frame or two
            await shot(`hub-settings-providers-${w}`);
            const seen = await ev(`(() => { const p = document.getElementById('settings-pane-providers'); const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; return { paneShown: !!p && vis(p), texts: p ? [...p.querySelectorAll('*')].filter(e => vis(e) && e.children.length === 0 && (e.textContent || '').trim()).map(e => e.textContent.trim().slice(0, 30)) : [] }; })()`);
            assert.deepEqual(seen.texts, [], `${w}: nothing of the Providers pane is drawn in hub mode (asked for by name): ` + JSON.stringify(seen));
        }
        console.log('hub_settings_providers_hidden: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
