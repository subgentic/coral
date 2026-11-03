// Three findings of the keyboard audit (#12963), fixed in #12966, each checked with real key presses:
//  1. "Skip to message box" is a Tab stop only while the message box is on screen (it was the second stop of every page, and Enter on it went nowhere without an open agent); with an agent open it is there and lands the focus in the box.
//  2. (A pin, not a fix: the audit's finding was a false alarm. 'Updates' lives in the General tab, so the focus was on the selected tab all along; for every group the focus is on the selected tab, checked here for Terminal.)
//  3. The New goal title shows the standard 2 px focus ring when a key reaches it (its 1 px underline was the only mark).
// 1280 px and 200% text, isolated dev server, mock agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const { coralReady } = require('./helpers/wait');
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const key = async (k, mods = 0) => { const code = { Tab: 9, Escape: 27, Enter: 13 }[k]; await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); };
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // only for the 20 ms between key presses
    const pause = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the effect of a key press or a dialog opening has no event to wait for; the checks after it are on what is on screen
    const stops = async n => { await ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); (() => { const a = [...document.querySelectorAll('a')].find(x => /Skip to main content/.test(x.textContent)); if (a) a.focus(); })(); true`); const out = ['(start: skip to main content)']; for (let i = 0; i < n; i++) { await key('Tab'); await sleep(20); out.push(await ev(`(() => { const e = document.activeElement; return e && e !== document.body ? ((e.textContent || e.getAttribute('aria-label') || e.id || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40)) : 'BODY'; })()`)); } return out; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, fs] of [[1280, 900, false, 16], [1280, 900, false, 32]]) {
            const tag = `${w} px ${fs === 32 ? '200% text' : '100%'}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; localStorage.clear(); true`);
            // 1. no agent open: the link is not offered
            await ev(`window.__m.agents = {}; window.__m.add('kb-a', 'A', 3, { sleeping: false, session_id: 'kb-a-id' }); true`); await pause(500); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            check(`${tag}: no open agent: the skip link is hidden`, (await ev(`document.querySelector('.skip-link').hidden`)) === true && (await ev(`document.querySelector('.skip-link').getClientRects().length`)) === 0);
            const first = await stops(16);
            check(`${tag}: and it is not a Tab stop`, !first.some(x => /Skip to message box/.test(x)), JSON.stringify(first));
                        // an agent is opened: the link is back and lands the focus in the box
            await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.selectLiveSession('kb-a', 'claude', 'kb-a-id', 'local'); true`);
            await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, `${tag}: the message box`, 10000);
            await waitFor(`document.querySelector('.skip-link').hidden === false`, `${tag}: the link comes back`, 5000);
            const second = await stops(16);
            check(`${tag}: with an agent open the link is a Tab stop`, second.some(x => /Skip to message box/.test(x)), JSON.stringify(second));
            await ev(`[...document.querySelectorAll('.skip-link')].find(a => !a.hidden).focus(); true`); await key('Enter'); await pause(300); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            check(`${tag}: Enter on it puts the focus in the message box`, (await ev(`document.activeElement && document.activeElement.id`)) === 'command-input', await ev(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`));
            // the agent is closed again: the link goes
            await ev(`window.__m.agents = {}; window.__qaState.liveSessions = []; window.showView && window.showView('empty'); true`);
            // 2. Settings opened to a pane: the focus is on that pane's tab
            await ev(`window.showSettingsModal('terminal'); true`); await waitFor(`document.getElementById('settings-modal') && getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, `${tag}: Settings`, 8000); await pause(800); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            const on = await ev(`(() => { const e = document.activeElement, sel = document.querySelector('#settings-modal [role=tab][aria-selected="true"]'); return { active: e && e.id, tag: e && e.tagName, selected: sel && sel.id, tabShown: !!sel && sel.getClientRects().length > 0, inside: !!e && !!e.closest('#settings-modal'), label: e ? (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40) : '' }; })()`);
            check(`${tag}: Settings opened to Terminal: the focus is on that pane's tab (or, where the tabs are folded away at 200%, inside the dialog on its section control)`, on.selected === 'settings-tab-terminal' && (on.tabShown ? on.active === 'settings-tab-terminal' : on.inside && on.tag !== 'BODY'), JSON.stringify(on));
            await key('Escape'); await pause(400); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            await ev(`window.showSettingsModal(); true`); await pause(1000); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            const dflt = await ev(`(() => { const e = document.activeElement, sel = document.querySelector('#settings-modal [role=tab][aria-selected="true"]'); return { active: e && e.id, selected: sel && sel.id }; })()`);
            check(`${tag}: Settings opened plainly: the focus is on the selected tab too`, dflt.active === dflt.selected && !!dflt.active, JSON.stringify(dflt));
            await key('Escape'); await pause(400); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            // 3. New goal title: the ring when a key reaches it
            await ev(`import((window.__coralStatic || '/static/') + 'goal_editor.js').then(m => { m.openGoalEditor({ project: 'kb-team' }); return true; })`);
            await waitFor(`!!document.querySelector('dialog.goal-editor[open] #goal-new-title')`, `${tag}: the New goal screen`, 8000); await pause(500); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            await ev(`document.querySelector('.goal-tb').focus(); true`); await key('Tab', 8); await pause(150); // Shift+Tab: back to the title // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
            const ring = await ev(`(() => { const e = document.activeElement; const c = getComputedStyle(e); return { id: e.id, fv: e.matches(':focus-visible'), style: c.outlineStyle, width: c.outlineWidth }; })()`);
            check(`${tag}: a key to the New goal title shows the 2 px ring`, ring.id === 'goal-new-title' && ring.fv && ring.style === 'solid' && parseFloat(ring.width) >= 2, JSON.stringify(ring));
            await key('Escape'); await pause(300); // sleep-ok: a key press or a dialog opening has no event; the check after it reads what is on screen
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the keyboard audit fixes (#12966):\n  ' + problems.join('\n  '));
    console.log('PASS the skip link, the Settings tab and the New goal title ring, by key presses');
})().catch(e => { console.error(e); process.exit(1); });
