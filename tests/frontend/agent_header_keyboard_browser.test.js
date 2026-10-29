// The agent header by keyboard and screen reader (#9899, v2.0.3: #9836, #9837): the Chat and Terminal view toggle is the first of the actions at the right; the folder is not in the header, it is the tip on the name's keyboard focus (and on a mouse's hover) and the first
// fact of Details, which is under the header at every width. Real keys (Tab, Enter, Space, Escape), names as Chrome computes them (axName), 1280, 1024 and 390 px, 200% text, forced colours. The tip is a CSS tip, so a screen reader needs the folder said another way
// (the name's description) and Escape dismisses it (WCAG 1.4.13); the toggle says which view is on (aria-pressed) and keeps the keyboard; Details opens with Enter and Space. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter'], ' ': [32, 'Space'], Escape: [27, 'Escape'], Shift: [16, 'ShiftLeft'] };
    const key = async (k, shift) => { const [code, name] = KEYS[k]; const text = k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined; const mods = shift ? 8 : 0; await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, text, modifiers: mods }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code, modifiers: mods }); await new Promise(r => setTimeout(r, 120)); }; // sleep-ok: the key's handlers run
    const settle = () => new Promise(r => setTimeout(r, 300)); // sleep-ok: the header redraws
    const FOLDER = '/work/coral-project';
    const base = o => Object.assign({ name: 'coral-go', display_name: '', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', branch: 'feat/long-branch-name', repo_name: 'coral', working_directory: FOLDER, status: 'idle', server: 'local' }, o);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const act = () => ev(`(() => { const e = document.activeElement; return e ? { tag: e.tagName, id: e.id || '', cls: String(e.className || '').slice(0, 40), label: (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), inHeader: !!e.closest('.terminal-header'), inDetails: !!e.closest('#agent-phone-details') } : null; })()`);
    const tip = () => ev(`getComputedStyle(document.querySelector('#live-session-view .terminal-header'), '::after').content`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, mobile] of [['1280', 1280, false], ['1024', 1024, false], ['390', 390, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${tag}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([base({ session_id: 'o1', display_name: 'Worker', working: true })])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            await ev(`window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
            await waitFor(`!!document.querySelector('#live-session-view .terminal-header[data-folder]') && document.querySelector('#live-session-view .terminal-header').getClientRects().length > 0`, `${tag}: the header with its folder`, 8000);
            await settle();
            // Tab order through the header: the name, the branch, the view toggle first of the actions at the right
            await ev(`document.querySelector('#live-session-view .terminal-header').scrollIntoView(); const first = [...document.querySelectorAll('#live-session-view .terminal-header [tabindex="0"], #live-session-view .terminal-header button')].find(e => e.getClientRects().length > 0); first.focus(); true`);
            const seq = [await act()]; for (let i = 0; i < 9; i++) { await key('Tab'); const a = await act(); seq.push(a); if (!a.inHeader) break; }
            const names = seq.filter(a => a.inHeader).map(a => a.id || a.label);
            const idxId = names.indexOf('terminal-header-identity'), idxChat = names.indexOf('live-view-btn-chat'), idxTerm = names.indexOf('live-view-btn-terminal');
            check(idxId >= 0 && idxChat > idxId && idxTerm === idxChat + 1, `Tab goes the name, then the Chat and Terminal toggle (the first of the actions): ${JSON.stringify(names)}`);
            // the folder: a tip on the name's keyboard focus, dismissed with Escape, and said to a screen reader
            await key('Shift'); await ev(`document.getElementById('terminal-header-identity').focus(); true`); await new Promise(r => setTimeout(r, 120)); // sleep-ok: a key press first, so the focus is a keyboard focus (focus-visible)
            const onName = (await act()).id === 'terminal-header-identity';
            check(onName, 'Tab reaches the name');
            if (onName) {
                check(JSON.stringify(await tip()) === JSON.stringify(`"${FOLDER}"`) , `the name's keyboard focus shows the folder in a tip: ${await tip()}`);
                await ev(`document.activeElement.setAttribute('data-axp', 'x'); true`); const ax = await axName(client, '[data-axp="x"]');
                check(!!ax && (ax.description || '').includes(FOLDER), `a screen reader is told the folder (the name's description), the tip is not heard: ${JSON.stringify(ax)}`);
                await key('Escape'); check(await tip() === 'none', `Escape dismisses the tip (WCAG 1.4.13): ${await tip()}`); check((await act()).id === 'terminal-header-identity', 'and the keyboard stays on the name');
                await ev(`document.getElementById('live-view-btn-chat').focus(); true`); await key('Shift'); await ev(`document.getElementById('terminal-header-identity').focus(); true`); await new Promise(r => setTimeout(r, 120)); check(JSON.stringify(await tip()) === JSON.stringify(`"${FOLDER}"`), `the tip is back when the keyboard returns to the name: ${await tip()}`); // sleep-ok: the focus returns to the name
            }
            // the view toggle: Tab, Space and Enter switch the view, aria-pressed says which, the keyboard stays
            await ev(`document.getElementById('live-view-btn-terminal').focus(); true`); await key('Enter');
            check(await ev(`document.getElementById('live-view-btn-terminal').getAttribute('aria-pressed') === 'true' && document.getElementById('live-view-btn-chat').getAttribute('aria-pressed') === 'false'`), 'Enter on Terminal switches the view and aria-pressed says so');
            check((await act()).id === 'live-view-btn-terminal', 'and the keyboard stays on the toggle');
            await ev(`document.getElementById('live-view-btn-chat').focus(); true`); await key(' ');
            check(await ev(`document.getElementById('live-view-btn-chat').getAttribute('aria-pressed') === 'true'`), 'Space on Chat switches back');
            // Details at every width
            const det = await ev(`(() => { const d = document.getElementById('agent-phone-details'), m = document.getElementById('agent-bar-more'); return d && !d.hidden && m && m.getClientRects().length > 0; })()`);
            check(det === await ev(`innerWidth <= 1100 && innerHeight > 500`), 'the Details are one button in the header row up to 1100 px (⋯, #11056), and not offered wider');
            // under 640 px the summary is hidden and ⋯ opens the Details (#11056): the keyboard goes through that button; wider, the summary is the control
            const more = await ev(`getComputedStyle(document.getElementById('agent-bar-more')).display !== 'none'`);
            if (det) { await ev(`document.getElementById('agent-phone-details').open = false; document.getElementById('agent-bar-more').setAttribute('aria-expanded', 'false'); document.querySelector('#agent-bar-more').focus(); true`); await key('Enter'); check(await ev(`document.getElementById('agent-phone-details').open`), 'Enter opens Details'); await key(' '); check(!(await ev(`document.getElementById('agent-phone-details').open`)), 'Space closes it'); await ev(`document.getElementById('agent-phone-details').open = true; true`); const f0 = await ev(`(document.querySelector('#agent-phone-details .facts-row dd') || {}).textContent`); check(f0 === FOLDER, `the first fact is the folder (it is not in the header): ${JSON.stringify(f0)}`); await ev(`document.getElementById('agent-phone-details').open = false; true`); }
            // 200% text: the header does not run off, the toggle and the actions are on screen
            await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle();
            const big = await ev(`(() => { const h = document.querySelector('#live-session-view .terminal-header'), r = h.getBoundingClientRect(); const bad = [...h.querySelectorAll('button, .live-view-toggle')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().left < -1)).map(e => e.id || e.className); return { sw: h.scrollWidth, cw: h.clientWidth, deep: [...h.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.right + parseFloat(getComputedStyle(e).marginRight || 0) > h.getBoundingClientRect().right - 6 - 0.5 && r.width > 0; }).map(e => (e.id || String(e.className) || e.tagName).slice(0, 30) + ':' + Math.round(e.getBoundingClientRect().right) + '+' + getComputedStyle(e).marginRight).slice(0, 8), docsw: document.documentElement.scrollWidth, hscroll: h.scrollWidth > h.clientWidth + 1, offscreen: bad, headerRight: Math.round(r.right), vw: innerWidth, wide: [...h.children].concat([...h.querySelectorAll('.terminal-header-left > *, .terminal-header-actions > *')]).filter(e => e.getBoundingClientRect().right > h.getBoundingClientRect().right + 1).map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().right)) }; })()`);
            await shot(`agent-header-200-${tag}`);
            check(big.docsw <= big.vw && big.offscreen.length === 0 && big.wide.length === 0, `at 200% text the header keeps its toggle and buttons on the screen: ${JSON.stringify(big)}`);
            await ev(`document.documentElement.style.fontSize = ''; true`); await settle();
        }
        // forced colours: the name's keyboard focus is outlined
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await client.Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] }); await settle();
        await key('Shift'); await ev(`document.getElementById('terminal-header-identity').focus(); true`); await new Promise(r => setTimeout(r, 120)); // sleep-ok: keyboard focus
        const onName2 = (await act()).id === 'terminal-header-identity';
        const fc = await ev(`(() => { const e = document.getElementById('terminal-header-identity'), cs = getComputedStyle(e); return { outline: cs.outlineStyle + ' ' + cs.outlineWidth, focused: document.activeElement === e }; })()`);
        if (!onName2 || !fc.focused || /^none/.test(fc.outline) || / 0px$/.test(fc.outline)) problems.push('forced colours: the name\'s keyboard focus shows an outline: ' + JSON.stringify(fc));
        await client.Emulation.setEmulatedMedia({ features: [] });
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the agent header by keyboard and screen reader:\n  ' + problems.join('\n  '));
    console.log('PASS the agent header by keyboard and screen reader');
})().catch(e => { console.error(e); process.exit(1); });
