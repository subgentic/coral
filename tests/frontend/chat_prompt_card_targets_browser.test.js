// A phone's chat controls are 44 px touch targets (#16356, Beta Tester's walk #16339): the prompt card's Open terminal and Dismiss (they were 81x26 and 44x26) and the composer's image button (33x33), in the
// chat view at 390 and 360 px, in a window up to 767 px wide with a mouse, and on a touch screen of any width (a phone turned sideways, a tablet). On a wide screen the card's links keep their small size. The card is drawn on its own as dismiss_wait_browser does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, touch, theme] of [[390, 844, true, true, 'dark'], [390, 844, true, true, 'light'], [390, 844, false, false, 'dark'], [360, 800, true, true, 'dark'], [700, 900, false, false, 'dark'], [844, 390, true, true, 'dark'], [1024, 768, true, true, 'dark'], [1280, 900, false, false, 'dark'], [1280, 900, false, false, 'light']]) {
            const tag = `${w}${touch ? '-touch' : ''}-${theme}`, phone = w <= 767 || touch; // a narrow window, or a touch screen of any width (a phone turned sideways, a tablet)
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: touch });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
            await ev(`window.__m.add('ct-a', 'A', 4, { sleeping: false }); true`); await select('ct-a');
            await ev(`window.setLiveViewMode && window.setLiveViewMode('chat'); true`);
            await waitFor(`!!document.querySelector('.attach-image-btn')?.checkVisibility()`, `${tag}: the composer`, 10000);
            await ev(`window.__row = { session_id: 'ct-id', name: 'claude-ct-id', display_name: 'Agent 1', agent_type: 'claude', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: npm test', waiting_since: new Date().toISOString(), status: 'idle', server: 'local' };
                window.__host = document.createElement('div'); window.__host.id = 'ct-host'; window.__host.style.cssText = 'position:fixed;left:0;right:0;bottom:120px;z-index:9999;background:var(--bg-primary)'; document.body.append(window.__host);
                import((window.__coralStatic || '/static/') + 'needs_input_card.js').then(m => { m.syncNeedsInputCard(window.__host, window.__row); return true; })`);
            await waitFor(`!!document.querySelector('#ct-host [data-on-click="terminal-view-open"]')`, `${tag}: the card`, 8000);
            const sizes = await ev(`(() => { const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }; return { terminal: box(document.querySelector('#ct-host [data-on-click="terminal-view-open"]')), dismiss: box(document.querySelector('#ct-host [data-on-click="dismiss-wait"]')), image: box(document.querySelector('.attach-image-btn')) }; })()`);
            if (phone) for (const k of ['terminal', 'dismiss', 'image']) { const s = sizes[k]; if (!s || s.w < 44 || s.h < 44) problems.push(`${tag}: ${k} is ${s ? s.w + 'x' + s.h : 'missing'}, not a 44 px target`); }
            else if (!sizes.terminal || !sizes.dismiss) problems.push(`${tag}: the card's controls are missing: ${JSON.stringify(sizes)}`);
            await shot(`chat-targets-${tag}`);
            await ev(`document.getElementById('ct-host').remove(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], '\n' + problems.join('\n'));
    console.log('chat_prompt_card_targets_browser: ok (the phone chat controls are 44 px targets)');
})().catch(e => { console.error(e); process.exit(1); });
