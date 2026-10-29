// A long agent name does not take over the composer (#8206, UI/UX's answer to the #8194 walk): the box's placeholder never wraps, and past 24 characters of name it says "this agent"; the starting
// text no longer carries "you can type now" (Send's own title says a message is held). 390 px and 1280 px, a starting agent with a 60-character name and one with a short name.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server, as first_run_status_words_browser does.
const { connect } = require('./agent_view_harness');
const { framesJs, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const LONG = 'Senior Backend Reliability Engineer for the Tunnel Subsystem';
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const words = await ev(`(async () => { const ss = await import(${S} + 'session_state.js');
                return { longStart: ss.startingPlaceholder(${JSON.stringify(LONG)}), longMsg: ss.commandPlaceholder(${JSON.stringify(LONG)}, 'claude'), shortStart: ss.startingPlaceholder('Backend Dev'), shortMsg: ss.commandPlaceholder('Backend Dev', 'claude'), edge: ss.startingPlaceholder('x'.repeat(24)), over: ss.startingPlaceholder('x'.repeat(25)) }; })()`);
            if (mobile) check(`${tag}: the phone's box holds about 16 characters beside its buttons: "Starting…" and "Message…", whatever the name`, words.longStart === 'Starting\u2026' && words.longMsg === 'Message\u2026' && words.shortStart === 'Starting\u2026' && words.shortMsg === 'Message\u2026', JSON.stringify(words));
            else {
                check(`${tag}: a name past 24 characters reads "this agent" in both placeholders`, /^Starting this agent/.test(words.longStart) && /^Message this agent/.test(words.longMsg), JSON.stringify(words));
                check(`${tag}: a short name stays, 24 characters is still a name and 25 is not`, /^Starting Backend Dev/.test(words.shortStart) && /^Message Backend Dev/.test(words.shortMsg) && /^Starting x{24}/.test(words.edge) && /^Starting this agent/.test(words.over), JSON.stringify(words));
            }
            check(`${tag}: the starting words do not carry "you can type now" (Send's title says a message is held)`, !/you can type now/.test(words.longStart + words.shortStart), words.shortStart);
            await ev(`(() => { const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), starting: true }); return true; })()`);
            const boxOf = async (name) => {
                await ev(`window.__m.add(${JSON.stringify(name)}, 'A', 3, { sleeping: false }); true`);
                await sleep(600); // sleep-ok: the first live list renders from several answers; no single completion event
                await ev(`window.selectLiveSession(${JSON.stringify(name)}, 'claude', ${JSON.stringify(name + '-id')}, 'local'); true`);
                await waitFor(`/^Starting/.test(document.getElementById('command-input').placeholder) && (${mobile} || document.getElementById('command-input').placeholder.includes(${JSON.stringify(name.length > 24 ? 'this agent' : name)}))`, 'the starting placeholder of ' + name.slice(0, 20), 6000);
                await sleep(500); // sleep-ok: the box sizes itself to its placeholder after layout
                return ev(`(() => { const i = document.getElementById('command-input'); const r = i.getBoundingClientRect(); return { ph: i.placeholder, h: Math.round(r.height), ws: getComputedStyle(i, '::placeholder').whiteSpace }; })()`);
            };
            const short = await boxOf('Backend Dev'), long = await boxOf(LONG);
            check(`${tag}: a long name makes the box no taller than a short name's, with the starting words`, /^Starting/.test(long.ph) && long.h <= short.h, JSON.stringify({ short, long }));
            const hint = await ev(`(() => { const h = document.getElementById('composer-starting-hint'); const r = h && h.getBoundingClientRect(); const i = document.getElementById('command-input').getBoundingClientRect(); return h ? { shown: !h.hidden && !!h.getClientRects().length, text: h.textContent, above: r.bottom <= i.top + 1, inWidth: r.right <= innerWidth + 1 } : null; })()`);
            check(`${tag}: while the agent starts a quiet line above the box says how long a message waits and that nothing is sent if it is not ready`, hint && hint.shown && /waits a few seconds/.test(hint.text) && /nothing is sent/.test(hint.text) && hint.above && hint.inWidth, JSON.stringify(hint));
            const rewrites = await ev(`(async () => { const st = await import(${S} + 'agent_starting.js'); const h = document.getElementById('composer-starting-hint'); let n = 0; const mo = new MutationObserver(m => { n += m.length; }); mo.observe(h, { childList: true, characterData: true, subtree: true });
                for (let i = 0; i < 3; i++) { st.syncSendStarting(true); await ${framesJs(2)}; } await new Promise(r => setTimeout(r, 50)); mo.disconnect(); return n; })()`);
            check(`${tag}: a toolbar rebuild (syncSendStarting again) does not rewrite the hint's text`, rewrites === 0, String(rewrites));
            if (process.env.SHOT_DIR) require('node:fs').writeFileSync(`${process.env.SHOT_DIR}/composer-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); // a picture for a review, when asked for
            if (mobile) check(`${tag}: the phone's placeholder does not wrap`, long.ws === 'nowrap', JSON.stringify(long));
            await ev(`(async () => { const st = await import(${S} + 'agent_starting.js'); st.syncSendStarting(false); return true; })()`);
            check(`${tag}: and the line is gone once the agent is up`, await ev(`document.getElementById('composer-starting-hint').hidden === true`));
        }
    } catch (e) { check('the suite ran', false, String(e && e.stack || e).slice(0, 300)); }
    await client.close();
    if (results.some(r => !r)) process.exit(1);
    console.log(`PASS ${results.length} checks`);
})();
