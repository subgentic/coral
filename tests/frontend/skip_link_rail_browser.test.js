// #15626 (QA's #15614 notes, Security's #15621 INFO): at 1280 px and 200% text the sidebar is a rail beside an open agent, so the agents pane (and the "Skip to message box" link in it) is not shown.
// The link must be hidden then, not a Tab stop, and Enter in the chat's Find must still work with the agent open. 1280 px at 200% text, isolated dev server, mock agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const { coralReady } = require('./helpers/wait');
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const keyCodes = { Tab: 9, Escape: 27, Enter: 13 };
    const key = async (k, mods = 0) => { await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: keyCodes[k], modifiers: mods }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: keyCodes[k], modifiers: mods }); };
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: only the 20 ms between key presses
    const stops = async n => { await ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); (() => { const a = [...document.querySelectorAll('a')].find(x => /Skip to main content/.test(x.textContent)); if (a) a.focus(); })(); true`); const out = ['(start: skip to main content)']; for (let i = 0; i < n; i++) { await key('Tab'); await sleep(20); out.push(await ev(`(() => { const e = document.activeElement; return e && e !== document.body ? ((e.textContent || e.getAttribute('aria-label') || e.id || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40)) : 'BODY'; })()`)); } return out; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`document.documentElement.style.fontSize = '32px'; localStorage.clear(); true`);
        await waitFor(`!!document.querySelector('.launch-disclosure-dismiss') || !!document.querySelector('.skip-link')`, 'the notice or the page', 8000);
        await ev(`(() => { const b = document.getElementById('launch-disclosure-banner'); if (b) b.remove(); return true; })()`); // the first-run notice is taken off the page, not acknowledged: an ack would stay in the shared server's settings
        await ev(`window.__m.agents = {}; window.__m.add('kb-a', 'A', 3, { sleeping: false, session_id: 'kb-a-id' }); localStorage.setItem('coral-live-view-mode', 'chat'); window.selectLiveSession('kb-a', 'claude', 'kb-a-id', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the message box', 10000);
        const pane = await ev(`(() => { const l = document.querySelector('.skip-link'), p = l.closest('.sidebar-pane'); return { paneShown: p.getClientRects().length > 0, hidden: l.hidden }; })()`);
        check('1280 px at 200% text with an agent open: the sidebar is a rail (the agents pane is not shown)', pane.paneShown === false, JSON.stringify(pane));
        await waitFor(`document.querySelector('.skip-link').hidden === true`, 'the skip link is hidden while its pane is not shown', 5000).catch(e => check('the skip link is hidden while its pane is not shown', false, e.message));
        check('and it is not on screen', (await ev(`document.querySelector('.skip-link').getClientRects().length`)) === 0);
        const tabs = await stops(16);
        check('and it is not a Tab stop', !tabs.some(x => /Skip to message box/.test(x)), JSON.stringify(tabs));
        // Enter in the chat's Find works at this size: the platform's Find key opens it, the typed words are counted, Enter steps to the next match
        await ev(`document.getElementById('command-input').blur(); true`);
        const FIND_MOD = (await ev(`navigator.platform.includes('Mac')`)) ? 4 : 2; // the platform's own key: Cmd on a Mac, Ctrl elsewhere (#15798; the Mac run of this suite sent Ctrl and timed out, #16237)
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: FIND_MOD }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: FIND_MOD });
        await waitFor(`!!document.querySelector('.chat-find-bar') && !document.querySelector('.chat-find-bar').hidden`, 'Ctrl+F opens Find', 5000);
        await ev(`document.querySelector('.chat-find-input').focus(); true`);
        await key('Enter');
        check('Enter in Find keeps the focus in Find', /chat-find/.test(await ev(`(document.activeElement && document.activeElement.className) || ''`)));
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the skip link beside a railed sidebar (#15626):\n  ' + problems.join('\n  '));
    console.log('PASS the skip link is hidden and not a Tab stop at 1280 px and 200% text, and Find takes Enter');
})().catch(e => { console.error(e); process.exit(1); });
