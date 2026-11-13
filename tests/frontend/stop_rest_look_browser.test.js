// The chat's Stop is a Default button while an agent works (design guidelines section 8, #15822): grey at rest in both themes, red only on hover or press, the phone's button still 44 px; its name and the Escape it sends are
// unchanged (chat_stop_desktop_browser, stop_and_wait_words_browser). 1440 dark/light, 200% text, 390 touch dark/light. A mocked agent whose state the test sets (stop_and_wait_words_browser's way); isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const Input = client.Input; const problems = []; const check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a frame for the page to learn the state; there is no completion event
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        const row = patch => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'session_header_updates.js'); const base = window.__m.entry(Object.values(window.__m.agents).find(a => a.name === 'sw')); const e = { ...base, session_id: 'sw-id', ...${JSON.stringify(patch)} }; m.updateWaitingIndicator(e); (await import((window.__coralStatic || '/static/') + 'session_state.js')).applyTerminalDot(document.getElementById('terminal-status-dot'), e); await new Promise(r => setTimeout(r, 80)); return true; })()`);
        for (const [label, w, theme, zoom, mobile] of [['1440 dark', 1440, 'dark', ''], ['1440 light', 1440, 'light', ''], ['1440 200% text', 1440, 'dark', '200%'], ['390 touch dark', 390, 'dark', '', true], ['390 touch light', 390, 'light', '', true]]) {
            const at = label + ': ';
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: !!mobile }); await Emulation.setTouchEmulationEnabled({ enabled: !!mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__m.add('sw', 'A', 6, { sleeping: false, session_id: 'sw-id' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
            await select('sw');
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, at + 'the chat', 15000);
            await row({ working: false }); await sleep(200); // sleep-ok: a frame for the page to learn the state; there is no completion event
            await row({ working: true }); await sleep(200); // sleep-ok: a frame for the page to learn the state; there is no completion event
            await waitFor(mobile ? `document.getElementById('mobile-send-btn').classList.contains('is-stop')` : `document.getElementById('command-pane').getAttribute('data-stop-now') === 'true' && document.getElementById('command-pane').getAttribute('data-can-stop') === 'true' && document.querySelector('#command-pane .btn-esc').getClientRects().length > 0`, at + 'Stop is shown', 8000);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            const SEL = mobile ? '#mobile-send-btn' : '#command-pane .btn-esc';
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
            const look = () => ev(`(() => { const b = document.querySelector(${JSON.stringify(SEL)}); const cs = getComputedStyle(b), r = b.getBoundingClientRect(), p = document.createElement('i'); p.style.background = 'var(--danger)'; document.body.append(p); const danger = getComputedStyle(p).backgroundColor; p.remove(); return { bg: cs.backgroundColor, danger, h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), hover: b.matches(':hover') }; })()`);
            const rest = await look();
            check(rest.bg !== rest.danger && rest.bg !== 'rgba(0, 0, 0, 0)', `${at}Stop is not red at rest (${rest.bg}, red is ${rest.danger})`);
            if (mobile) check(rest.h >= 44, `${at}the phone's Stop is still 44 px (${rest.h})`);
            await shot('stop-rest-' + label.replace(/ /g, '-'));
            await ev(`document.querySelector(${JSON.stringify(SEL)}).scrollIntoView({ block: 'center', inline: 'center' }); true`);
            let hot = rest; // the 200% text reflow keeps moving the button for a moment: aim at where it is now until the pointer is over it and the colour has eased in
            for (let k = 0; k < 40 && !(hot.hover && hot.bg === hot.danger); k++) { const pos = await look(); await Input.dispatchMouseEvent({ type: 'mouseMoved', x: pos.cx, y: pos.cy }); await sleep(100); hot = await look(); } // sleep-ok: the reflow and the colour's ease take a few frames; there is no completion event
            check(hot.hover, `${at}the pointer is over Stop`);
            check(hot.bg === hot.danger, `${at}Stop turns red on hover (${hot.bg}, red is ${hot.danger})`);
            if (label === '1440 dark' || label === '390 touch light') await shot('stop-hover-' + label.replace(/ /g, '-'));
        }
    } finally { try { await client.close(); } catch (e) {} }
    assert.deepEqual(problems, [], 'The Stop button:\n  ' + problems.join('\n  '));
    console.log('PASS Stop is grey at rest and red on hover');
})().catch(e => { console.error(e); process.exit(1); });
