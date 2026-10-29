// The agent header's Details disclosure by keyboard alone (#9783, the v2.0.2 keyboard pass; #9686, #9755): below 1100 px (and on a phone) the model line is not in the header, so the folder, branch, model and thinking level are behind Details.
// Tab reaches it, Enter and Space open and close it, it shows where the keyboard is, its name is Details, and what opens is the facts, in order. 1024 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter'], ' ': [32, 'Space'] };
    const key = async (k, shift) => { const [code, name] = KEYS[k]; const text = k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined; const mods = shift ? 8 : 0; await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, text, modifiers: mods }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code, modifiers: mods }); await new Promise(r => setTimeout(r, 120)); }; // sleep-ok: the key's handlers run
    const base = o => Object.assign({ name: 'coral-go', display_name: '', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', branch: 'feat/long-branch-name', repo_name: 'coral', working_directory: '/work/coral-project', status: 'idle', server: 'local' }, o);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, mobile] of [['1024', 1024, false], ['390', 390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([base({ session_id: 'o1', display_name: 'Worker', working: true })])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            await ev(`window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
            await waitFor(`(() => { const d = document.getElementById('agent-phone-details'), m = document.getElementById('agent-bar-more'); return !!d && !d.hidden && !!m && m.getClientRects().length > 0; })()`, `${tag}: the ⋯ button for the Details shows`, 8000);
            await ev(`document.getElementById('agent-phone-details').open = false; document.getElementById('agent-bar-more').setAttribute('aria-expanded', 'false'); true`);
            await ev(`document.querySelector('#agent-bar-more').focus(); true`);
            const ax = await (async () => { await ev(`document.querySelector('#agent-bar-more').setAttribute('data-axp', 'x'); true`); return axName(client, '[data-axp="x"]'); })();
            check(ax && /^More about this agent$/.test(ax.name), `${tag}: the Details button's name is More about this agent (#11056): ${JSON.stringify(ax)}`);
            const ring = await ev(`(() => { const s = document.querySelector('#agent-bar-more'), cs = getComputedStyle(s); return { outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow, focused: document.activeElement === s, h: Math.round(s.getBoundingClientRect().height) }; })()`);
            check(ring.focused && ((ring.outline && !/^none/.test(ring.outline) && !/ 0px$/.test(ring.outline)) || ring.shadow !== 'none'), `${tag}: the focused Details shows a ring: ${JSON.stringify(ring)}`);
            await key('Enter'); check(await ev(`document.getElementById('agent-phone-details').open`), `${tag}: Enter opens Details`);
            const facts = await ev(`[...document.querySelectorAll('#agent-phone-details .facts-row')].filter(r => !r.hidden).map(r => r.querySelector('dt').textContent)`);
            check(JSON.stringify(facts) === JSON.stringify(['Folder', 'Branch', 'Model']) || facts.slice(0, 3).join() === 'Folder,Branch,Model', `${tag}: the facts come in order Folder, Branch, Model (then Thinking, Context when there are): ${JSON.stringify(facts)}`);
            await key(' '); check(!(await ev(`document.getElementById('agent-phone-details').open`)), `${tag}: Space closes Details`);
            check(await ev(`document.activeElement === document.querySelector('#agent-bar-more')`), `${tag}: focus stays on Details after it toggles`);
            await key('Tab'); const next = await ev(`(() => { const a = document.activeElement; return a ? (a.tagName + '#' + (a.id || '') + ' ' + (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30)) : ''; })()`);
            check(!/^BODY/.test(next) && next !== '', `${tag}: Tab goes on from Details to a control (${next})`);
            console.log(`   ${tag}: done`);
        }
    } finally { await client.close(); }
    assert.deepEqual(found, [], 'the agent header Details by keyboard:\n  ' + found.join('\n  '));
    console.log('PASS the agent header Details by keyboard');
})().catch(e => { console.error(e); process.exit(1); });
