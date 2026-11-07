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
        assert.equal(await ev(`document.querySelector('#restart-modal .acf-codex-narrows').textContent`), 'Running with Full access now; restarting starts Codex with Workspace write, asks when needed. A mode set inside Codex is not kept.');
        await ev(`window.hideRestartModal(); true`);
        await pick('cx-same', 'codex', 'cx-same-id');
        await ev(`window.restartSession(); true`);
        await waitFor(`getComputedStyle(document.getElementById('restart-modal')).display !== 'none'`, 'the restart dialog');
        assert.equal(await ev(`!!document.querySelector('#restart-modal .acf-codex-narrows')`), false, 'no note when a restart gives the same');
        await ev(`window.hideRestartModal(); true`);

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
        console.log('PASS codex mode');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
