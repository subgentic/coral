// A Codex agent's live mode (#14051), in the real page: the read-only chip beside the agent (from the list row's codex_live_mode, a warn border and a title when codex_relaunch_narrows says a relaunch
// would give less), the question before a Wake that would start it narrower (nothing is sent until it is confirmed; Cancel sends nothing; an agent a relaunch does not narrow is woken at once), and the
// note in the Restart form. Display only: nothing here changes a permission. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const FULL = { approval: 'never', sandbox: 'danger-full-access', label: 'Full access' };
const NARROWS = { live: 'Full access', launch: 'Workspace write, asks when needed' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            window.__state_ = (await import(st + 'state.js')).state;
            window.__rows = {}; window.__wakes = [];
            const orig = window.__m.entry.bind(window.__m);
            window.__m.entry = a => ({ ...orig(a), ...(window.__rows[a.session_id] || {}) });
            const prev = window.fetch;
            window.fetch = (u, o) => { const url = String(u); const m = url.match(/\\/api\\/sessions\\/live\\/([^/?]+)\\/wake/); if (m && o && o.method === 'POST') { window.__wakes.push(decodeURIComponent(m[1])); return Promise.resolve(new Response(JSON.stringify({ ok: true, sleeping: false }), { status: 200 })); } return prev(u, o); };
            return true; })()`);
        const rowsSet = (sid, extra) => ev(`window.__rows[${JSON.stringify(sid)}] = ${JSON.stringify(extra)}; true`);
        const add = (name, type, sleeping) => ev(`window.__m.add(${JSON.stringify(name)}, 'A', 3, { sleeping: ${sleeping}, agent_type: ${JSON.stringify(type)} }); true`);
        const pick = (name, type, sid) => ev(`window.selectLiveSession(${JSON.stringify(name)}, ${JSON.stringify(type)}, ${JSON.stringify(sid)}, 'local'); true`);
        const chip = () => ev(`(() => { const w = document.getElementById('codex-mode-wrap'), c = document.getElementById('codex-mode-chip'); return { hidden: w.hidden, text: document.getElementById('codex-mode-text').textContent, title: c.title, warn: c.dataset.warn || '', tag: c.tagName, focusable: c.tabIndex >= 0, label: c.getAttribute('aria-label') }; })()`);

        console.log('The chip: Full access with a warning when a relaunch would narrow it');
        await rowsSet('cx-narrow-id', { codex_live_mode: FULL, codex_relaunch_narrows: NARROWS });
        await add('cx-narrow', 'codex', false);
        await pick('cx-narrow', 'codex', 'cx-narrow-id');
        await waitFor(`!document.getElementById('codex-mode-wrap').hidden`, 'the mode chip');
        let c = await chip();
        assert.equal(c.text, 'Full access'); assert.equal(c.warn, 'on');
        assert.match(c.title, /newest turn/); assert.match(c.title, /Workspace write, asks when needed/);
        assert.equal(c.tag, 'SPAN', 'a display, not a button'); assert.equal(c.focusable, false);
        assert.match(c.label, /Full access, a restart would narrow it/);

        console.log('No warning when a relaunch gives the same; no chip when there is no mode, or for another agent');
        await rowsSet('cx-same-id', { codex_live_mode: { approval: 'on-request', sandbox: 'workspace-write', label: 'Workspace write, asks when needed' }, codex_relaunch_narrows: null });
        await add('cx-same', 'codex', false); await pick('cx-same', 'codex', 'cx-same-id');
        await waitFor(`document.getElementById('codex-mode-text').textContent === 'Workspace write, asks when needed'`, 'the same-mode chip');
        c = await chip(); assert.equal(c.hidden, false); assert.equal(c.warn, '');
        await rowsSet('cx-none-id', { codex_live_mode: null, codex_relaunch_narrows: null });
        await add('cx-none', 'codex', false); await pick('cx-none', 'codex', 'cx-none-id');
        await waitFor(`document.getElementById('codex-mode-wrap').hidden`, 'no chip without a mode');
        await add('cl-one', 'claude', false); await pick('cl-one', 'claude', 'cl-one-id');
        await waitFor(`document.getElementById('codex-mode-wrap').hidden && !document.getElementById('model-chip-bar').hidden`, 'no mode chip on a Claude agent, the model bar still there');

        console.log('Wake: a question first when a relaunch would narrow it; nothing is sent until it is confirmed');
        await rowsSet('cx-sleeper-id', { codex_live_mode: FULL, codex_relaunch_narrows: NARROWS });
        await add('cx-sleeper', 'codex', true);
        const confirmText = () => ev(`({ title: document.getElementById('confirm-modal-title').textContent, message: document.getElementById('confirm-modal-message').textContent, yes: document.getElementById('confirm-modal-yes').textContent, shown: getComputedStyle(document.getElementById('confirm-modal')).display !== 'none' })`);
        await ev(`window.__wakes.length = 0; window.toggleAgentSleep('cx-sleeper', 'codex', 'cx-sleeper-id', 'wake'); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the Wake question');
        let q = await confirmText();
        assert.equal(q.title, 'Wake agent'); assert.equal(q.yes, 'Wake agent');
        assert.match(q.message, /It ran with Full access\. Waking starts Codex again with Workspace write, asks when needed/);
        assert.match(q.message, /a mode set inside Codex is not kept/);
        assert.deepEqual(await ev(`window.__wakes`), [], 'nothing sent before the answer');
        await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
        assert.deepEqual(await ev(`window.__wakes`), [], 'Cancel sends nothing');
        await ev(`window.toggleAgentSleep('cx-sleeper', 'codex', 'cx-sleeper-id', 'wake'); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question again');
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__wakes.length === 1`, 'the wake after Confirm');
        assert.deepEqual(await ev(`window.__wakes`), ['cx-sleeper-id']);

        console.log('Wake without a narrowing (same mode, Claude): no question');
        await rowsSet('cx-calm-id', { codex_live_mode: { approval: 'on-request', sandbox: 'workspace-write', label: 'Workspace write, asks when needed' }, codex_relaunch_narrows: null });
        await add('cx-calm', 'codex', true); await add('cl-sleeper', 'claude', true);
        await ev(`window.__wakes.length = 0; window.toggleAgentSleep('cx-calm', 'codex', 'cx-calm-id', 'wake'); window.toggleAgentSleep('cl-sleeper', 'claude', 'cl-sleeper-id', 'wake'); true`);
        await waitFor(`window.__wakes.length === 2`, 'both woken at once');
        assert.equal(await ev(`getComputedStyle(document.getElementById('confirm-modal')).display`), 'none', 'no question');

        console.log('Restart: the note says what the restart will start it with');
        await pick('cx-narrow', 'codex', 'cx-narrow-id');
        await ev(`window.restartSession(); true`);
        await waitFor(`!!document.querySelector('#restart-modal .acf-codex-narrows')`, 'the restart note');
        assert.equal(await ev(`document.querySelector('#restart-modal .acf-codex-narrows').textContent`), 'Running with Full access now; restarting starts Codex with Workspace write, asks when needed, unless you change the permission mode or flags below. A mode set inside Codex is not kept.');
        await ev(`window.hideRestartModal(); true`);
        await pick('cx-same', 'codex', 'cx-same-id');
        await ev(`window.restartSession(); true`);
        await waitFor(`getComputedStyle(document.getElementById('restart-modal')).display !== 'none'`, 'the restart dialog');
        assert.equal(await ev(`!!document.querySelector('#restart-modal .acf-codex-narrows')`), false, 'no note when a restart gives the same');
        await ev(`window.hideRestartModal(); true`);

        console.log('Keep Full access (#14061): the chip with its one-click Off, the menu item, and the phone row; Off posts the exact target');
        await rowsSet('cx-keep-id', { codex_live_mode: FULL, codex_relaunch_narrows: null, keep_full_access: true });
        await add('cx-keep', 'codex', false); await pick('cx-keep', 'codex', 'cx-keep-id');
        await waitFor(`!document.getElementById('codex-keep-wrap').hidden`, 'the keep chip');
        assert.equal(await ev(`document.getElementById('codex-keep-text').textContent`), 'Full access kept on restart');
        assert.equal(await ev(`document.getElementById('codex-keep-off').textContent`), 'Off');
        await pick('cx-narrow', 'codex', 'cx-narrow-id');
        await waitFor(`document.getElementById('codex-keep-wrap').hidden`, 'no keep chip without the setting');
        // every request the page makes that is not a read, so "no unintended permission writes" is a fact of the run: the Off click makes exactly one, to the keep route, with exactly the target and the word
        await ev(`window.__writes = []; window.__keepReply = 'refuse'; const pf = window.fetch; window.fetch = (u, o) => { const m = String((o && o.method) || 'GET').toUpperCase(); const url = String(u);
            if (m !== 'GET' && m !== 'HEAD') window.__writes.push({ m, u: url, b: o && o.body ? String(o.body) : '' });
            if (url.includes('/keep-full-access') && m === 'POST') return Promise.resolve(window.__keepReply === 'refuse' ? new Response(JSON.stringify({ error: 'Could not save it. Try again.' }), { status: 500 }) : (window.__rows['cx-keep-id'] = { ...window.__rows['cx-keep-id'], keep_full_access: false }, new Response(JSON.stringify({ ok: true, keep_full_access: false }), { status: 200 })));
            if (/\\/api\\/sessions\\/live\\/cx-keep\\/info/.test(url)) return Promise.resolve(new Response(JSON.stringify({ agent_name: 'cx-keep', agent_type: 'codex', tmux_session_name: '', working_directory: '/w' }), { status: 200 }));
            return pf(u, o); }; true`);
        const keepWrites = () => ev(`window.__writes.filter(w => w.u.includes('/keep-full-access'))`);
        await pick('cx-keep', 'codex', 'cx-keep-id');
        await waitFor(`!document.getElementById('codex-keep-wrap').hidden`, 'the chip, back on the agent');
        await ev(`window.__writes.length = 0; true`); // selecting an agent makes the page's own calls: only what the click writes is counted

        console.log('A refusal keeps the state: the server says no, the chip stays, the row still says kept, the toast says so, and nothing else was written');
        await ev(`document.getElementById('codex-keep-off').click(); true`);
        await waitFor(`window.__writes.some(w => w.u.includes('/keep-full-access'))`, 'the refused Off post');
        const keepOnly = await keepWrites();
        assert.deepEqual(keepOnly.map(w => ({ m: w.m, b: JSON.parse(w.b) })), [{ m: 'POST', b: { session_id: 'cx-keep-id', agent_type: 'codex', on: false } }], 'one keep write: the exact target and the word');
        assert.match(keepOnly[0].u, /\/api\/sessions\/live\/cx-keep\/keep-full-access$/);
        const others = await ev(`window.__writes.filter(w => !w.u.includes('/keep-full-access')).map(w => w.m + ' ' + w.u.replace(location.origin, ''))`);
        console.log('  other writes the page made around the click (not this feature): ' + JSON.stringify(others));
        assert.deepEqual(others.filter(u => /permission|capabilit|flags|mode|restart|settings|wake|launch/i.test(u)), [], 'no permission, capability, flag, mode or restart write came with the click');
        assert.equal(await ev(`window.__state_.liveSessions.find(x => x.session_id === 'cx-keep-id').keep_full_access`), true, 'a refusal does not change the row');
        assert.equal(await ev(`document.getElementById('codex-keep-wrap').hidden`), false, 'the chip stays after a refusal');

        console.log('The Info tab says it plainly with a one-click Off (a refusal keeps it; Off turns it off and says so)');
        await ev(`window.toggleAgenticPanel(true); window.switchAgenticTab('info', 'top'); true`);
        await waitFor(`!document.getElementById('info-keep').hidden`, 'the Info tab line');
        assert.match(await ev(`document.getElementById('info-keep-label').textContent`), /Full access on restart/);
        assert.match(await ev(`document.getElementById('info-keep-text').textContent`), /^Kept: every restart/);
        assert.equal(await ev(`document.getElementById('info-keep-off').hidden`), false, 'the Off button');
        await ev(`window.__writes.length = 0; document.getElementById('info-keep-off').click(); true`);
        await waitFor(`window.__writes.some(w => w.u.includes('/keep-full-access'))`, 'the Info tab Off post (refused)');
        assert.equal(await ev(`document.getElementById('info-keep-off').hidden`), false, 'a refusal keeps the Info line and its button');
        await ev(`window.__keepReply = 'ok'; window.__writes.length = 0; document.getElementById('info-keep-off').click(); true`);
        await waitFor(`window.__writes.some(w => w.u.includes('/keep-full-access'))`, 'the Info tab Off post');
        assert.deepEqual((await keepWrites()).map(w => JSON.parse(w.b)), [{ session_id: 'cx-keep-id', agent_type: 'codex', on: false }], 'one keep write, the exact target');
        await waitFor(`document.getElementById('info-keep-off').hidden && /^Not kept/.test(document.getElementById('info-keep-text').textContent)`, 'the Info line says Not kept after Off');
        await waitFor(`document.getElementById('codex-keep-wrap').hidden`, 'the chip goes after Off');
        assert.equal(await ev(`window.__state_.liveSessions.find(x => x.session_id === 'cx-keep-id').keep_full_access`), false);
        await ev(`window.toggleAgenticPanel(false); true`);
        await ev(`window.__rows['cx-keep-id'] = { ...window.__rows['cx-keep-id'], keep_full_access: true }; window.__state_.liveSessions.find(x => x.session_id === 'cx-keep-id').keep_full_access = true; true`);

        console.log('Phone, 390 px, text 100% and 200%, both themes: no chip (the phone shows only its Options button), the mode is a line in the Options sheet, inside the screen, no sideways scroll');
        await pick('cx-narrow', 'codex', 'cx-narrow-id');
        await waitFor(`!document.getElementById('codex-mode-wrap').hidden`, 'the chip again');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        for (const rootPx of [null, '32px']) for (const theme of ['light', 'dark']) {
            const tag = `390 px, ${rootPx ? 'text 200%' : 'text 100%'}, ${theme}`;
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(rootPx || '')}; document.getElementById('options-chip').click(); true`);
            await waitFor(`!!document.querySelector('#options-chip-menu .options-sheet-mode-note')`, `${tag}: the mode line in the Options sheet`);
            const m = await ev(`(() => { const n = document.querySelector('#options-chip-menu .options-sheet-mode-note'), r = n.getBoundingClientRect(), vw = window.innerWidth, chipHidden = getComputedStyle(document.getElementById('codex-mode-chip')).display === 'none';
                return { text: n.textContent, warn: n.dataset.warn || '', tag: n.tagName, button: !!n.closest('button'), shown: r.width > 0 && r.height > 0, inView: r.left >= 0 && r.right <= vw + 1, wide: document.documentElement.scrollWidth > vw + 1, chipHidden, fs: getComputedStyle(document.documentElement).fontSize }; })()`);
            assert.equal(m.text, 'Mode: Full access', `${tag}: the line says the mode`); assert.equal(m.warn, 'on'); assert.equal(m.button, false, `${tag}: not a button`);
            assert.ok(m.shown && m.inView && !m.wide, `${tag}: the line is on screen, no sideways scroll: ${JSON.stringify(m)}`);
            assert.equal(m.chipHidden, true, `${tag}: the phone shows no separate chip`);
            if (rootPx) assert.equal(m.fs, rootPx, `${tag}: really at 200% text`);
            await ev(`document.getElementById('options-chip').click(); true`); // close the sheet
        }
        await ev(`document.documentElement.removeAttribute('data-theme'); document.documentElement.style.fontSize = ''; true`);
        await Emulation.clearDeviceMetricsOverride();

        console.log('Phone, 390 px: the Options sheet has the kept line with its Off (a button of the sheet), on screen; one tap is one write, the exact target');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await pick('cx-keep', 'codex', 'cx-keep-id');
        await ev(`document.getElementById('options-chip').click(); true`);
        await waitFor(`!!document.querySelector('#options-chip-menu [data-on-click="agent-keep-full-access"]')`, 'the phone Off row');
        const pk = await ev(`(() => { const b = document.querySelector('#options-chip-menu [data-on-click="agent-keep-full-access"]'), r = b.getBoundingClientRect(); return { text: b.textContent.trim(), mode: b.dataset.mode, sid: b.dataset.sessionId, shown: r.width > 0 && r.height > 0, inView: r.left >= 0 && r.right <= window.innerWidth + 1, tall: r.height >= 40 }; })()`);
        assert.equal(pk.text, 'Full access kept on restart: turn off'); assert.equal(pk.mode, 'off'); assert.equal(pk.sid, 'cx-keep-id');
        assert.ok(pk.shown && pk.inView, `the phone row is on screen: ${JSON.stringify(pk)}`);
        await ev(`window.__keepReply = 'ok'; window.__writes.length = 0; document.querySelector('#options-chip-menu [data-on-click="agent-keep-full-access"]').click(); true`);
        await waitFor(`window.__writes.some(w => w.u.includes('/keep-full-access'))`, 'the phone Off post');
        assert.deepEqual((await keepWrites()).map(w => JSON.parse(w.b)), [{ session_id: 'cx-keep-id', agent_type: 'codex', on: false }]);
        await Emulation.clearDeviceMetricsOverride();
        console.log('PASS codex mode');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
