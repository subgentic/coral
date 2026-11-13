// One control height on the agent chat page (design guidelines 4.6, #15821): the buttons were 16, 22, 24, 26, 28, 32, 36 and 37 px tall. Now every control on the page (the sidebar and the top navigation are other tasks) is 32 px (toolbar, composer, the
// chips) or 36 px (the dock's tabs), 44 on touch; a message's icon buttons are drawn at 24 px inside a 32 px hit area (44 on touch). 1440 px dark and light, 390 px touch, and 200% text (nothing shorter, nothing cut).
// Measured only after the chat is laid out; every box read in one call. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        const MODES = [['1440 px dark', 1440, 900, false, 'dark', ''], ['1440 px light', 1440, 900, false, 'light', ''], ['390 px touch', 390, 844, true, 'dark', ''], ['1440 px 200% text', 1440, 900, false, 'dark', '200%']];
        for (const [label, w, h, mobile, theme, zoom] of MODES) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__m.add('foot', 'F', 6, { sleeping: false }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            await select('foot');
            await waitFor(`window.__rendered && window.__rendered().length >= 4`, `${label}: the chat is drawn`, 15000);
            if (!mobile) await waitFor(`!!document.querySelector('#agentic-tab-files') && document.querySelector('#agentic-tab-files').getClientRects().length > 0`, `${label}: the dock's tabs are laid out`, 15000);
            await ev(`document.fonts.ready.then(() => ${framesJs(3, 600)})`);
            const r = await ev(`(() => { const out = []; for (const b of document.querySelectorAll('button, a.btn, [role="button"], input[type="button"], input[type="submit"], select, [role="tab"]')) { const x = b.getBoundingClientRect(); if (!x.width || !x.height || getComputedStyle(b).visibility === 'hidden') continue; if (b.closest('#sidebar, .sidebar, .top-bar, #top-bar, nav, .nav-tabs, .phone-nav, #launch-disclosure-banner')) continue; /* the app-wide launch banner is not a chat control: its Dismiss is a 44 px target (permissions_default_browser, #16095) */
                const row = !!b.closest('.chat-bubble') && b.classList.contains('btn-xs'), pe = row ? getComputedStyle(b, '::after') : null;
                out.push({ h: Math.round(x.height * 10) / 10, tab: b.classList.contains('agentic-tab'), row, hit: pe ? Math.round(parseFloat(pe.height)) : 0, inset: pe ? pe.top : '', clipped: b.scrollHeight > b.clientHeight + 1 && !b.matches('select'), name: ((b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 26)) + (b.id ? '#' + b.id : '') }); } return out; })()`);
            const at = label + ': ';
            check(r.length >= 12, `${at}the page's controls were found (${r.length})`);
            for (const b of r) {
                if (b.row && zoom) { check(b.h >= 24 - 0.5, `${at}row icon "${b.name}" is at least 24 px at 200% text (${b.h})`); continue; }
                if (b.row) { check(Math.abs(b.h - 24) <= 1 && Math.abs(b.hit - (mobile ? 44 : 32)) <= 1, `${at}row icon "${b.name}" is 24 px in a ${mobile ? 44 : 32} px hit area (${b.h}, ${b.hit})`); continue; }
                if (zoom) { check(b.h >= 32 - 0.5 && !b.clipped, `${at}"${b.name}" is at least 32 px and not cut at 200% text (${b.h}, clipped ${b.clipped})`); continue; }
                const want = mobile ? [44] : b.tab ? [36] : [32];
                check(want.some(v => Math.abs(b.h - v) <= 0.6), `${at}"${b.name}" is ${want.join(' or ')} px (${b.h})`);
            }
            if (label === '1440 px dark' || label === '390 px touch') await shot('chat-heights-' + label.replace(/ /g, '-'));
        }
    } finally { try { await client.close(); } catch (e) {} }
    assert.deepEqual(problems, [], 'The chat page controls:\n  ' + problems.join('\n  '));
    console.log('PASS the chat page has one control height');
})().catch(e => { console.error(e); process.exit(1); });
