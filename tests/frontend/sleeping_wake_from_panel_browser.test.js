// Waking an agent from the agent panel (#14323, the Operator): the chat that is open on it stops saying it is asleep by itself, with no press on the chat's own Wake.
// The panel's Wake is toggleAgentSleep(name, type, id, 'wake') (the row's button and menu call it); the mocked agent answers /wake and the feed is detached, so the only thing that can move the open chat is
// what the panel's wake does itself.
//   - the chat is open on a sleeping agent, then it is woken from the panel: the sleeping bar (its words and Wake), the asleep placeholder and the disabled input go away, the input is usable;
//   - a sleeping agent with no history yet (the chat's empty state says "This agent is asleep"): that notice goes too;
//   - the chat opened AFTER the wake shows an awake agent;
//   - the second Wake on an agent that is awake starts nothing: the server answers ok and no second re-select or relaunch is made by the page.
// 1280 and 390 px. Isolated dev server; the agents are the harness's in-page mocks.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Emulation, ev, waitFor, PRELOAD, install, select, clearReqs, reqs, Page } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); true`);
            const asleepWords = () => ev(`(() => { const bar = document.getElementById('sleeping-composer'), wake = document.getElementById('sleeping-wake-btn'), t = document.getElementById('sleeping-composer-text'),
                inp = document.getElementById('command-input'), pane = document.getElementById('command-pane'), vis = e => !!e && !e.hidden && e.getClientRects().length > 0;
                const empty = document.querySelector('#live-history-messages > .chat-empty');
                return { bar: vis(bar), wake: vis(wake), text: t ? t.textContent : '', inputDisabled: !!inp && inp.disabled, paneSleeping: !!pane && pane.classList.contains('agent-sleeping'),
                    emptyNotice: empty ? empty.textContent.replace(/\\s+/g, ' ').trim() : '' }; })()`);
            const panelWake = name => ev(`window.toggleAgentSleep(${JSON.stringify(name)}, 'claude', ${JSON.stringify(name + '-id')}, 'wake')`);
            const quiet = () => waitFor(`window.__m.requests.every(r => r.settled)`, `${at}requests settle`);

            // 1. chat open on a sleeping agent with history, woken from the panel
            await ev(`window.__m.add('pw-hist', 'H', 20, { sleeping: true })`);
            await select('pw-hist');
            await waitFor(`window.__rendered().length > 0 && !document.getElementById('sleeping-composer').hidden`, `${at}the sleeping chat is open`, 8000);
            let s = await asleepWords();
            check(s.bar && s.wake && s.paneSleeping && s.inputDisabled, `${at}before the wake the chat says asleep: ` + JSON.stringify(s));
            await clearReqs();
            check(await panelWake('pw-hist') === true, `${at}the panel's wake is applied`);
            await quiet();
            await waitFor(`document.getElementById('sleeping-composer').hidden === true`, `${at}the asleep bar goes by itself after a panel wake`, 5000).catch(() => {});
            s = await asleepWords();
            check(!s.bar && !s.wake && !s.paneSleeping && !s.inputDisabled, `${at}after a panel wake the open chat is awake (no bar, no Wake, input usable): ` + JSON.stringify(s));
            // the second press: nothing more is started
            await clearReqs();
            await panelWake('pw-hist'); await quiet();
            const r2 = await reqs();
            const selCalls = await ev(`window.__selCalls`);
            check(selCalls === 0, `${at}a second Wake on an awake agent re-selects nothing (${selCalls})`);
            s = await asleepWords();
            check(!s.bar && !s.inputDisabled, `${at}and the chat stays awake after it: ` + JSON.stringify(s));
            check(r2.filter(x => x.kind === 'wake').length <= 1, `${at}the page sent at most the one request for the second press: ` + JSON.stringify(r2.map(x => x.kind)));

            // the server's real answer to a Wake on an agent that is not asleep (sessions_sleep.go): 200 {ok:false, error:'Session is not sleeping'}; the chat stays as it is and says so
            await ev(`(() => { const R = window.fetch; window.__realFetch = R; window.fetch = (u, o = {}) => /\\/api\\/sessions\\/live\\/[^/]+\\/wake$/.test(String(u).split('?')[0]) ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'Session is not sleeping' }), { status: 200, headers: { 'content-type': 'application/json' } })) : R(u, o); return true; })()`);
            await clearReqs(); await ev(`document.querySelectorAll('.toast').forEach(e => e.remove()); true`);
            const refused = await panelWake('pw-hist');
            await ev(`window.fetch = window.__realFetch; true`);
            check(refused === false, `${at}a Wake the server refuses ('Session is not sleeping') is not applied`);
            check(await ev(`window.__selCalls`) === 0, `${at}and re-selects nothing`);
            s = await asleepWords();
            check(!s.bar && !s.wake && !s.paneSleeping && !s.inputDisabled, `${at}the chat stays awake after the refusal: ` + JSON.stringify(s));
            check((await ev(`[...document.querySelectorAll('.toast')].map(e => e.textContent.trim())`)).some(t => /not sleeping/i.test(t)), `${at}the refusal is told`);

            // 2. a sleeping agent with no history: the empty chat's own notice
            await ev(`window.__m.add('pw-new', 'N', 0, { sleeping: true })`);
            await select('pw-new');
            await waitFor(`!document.getElementById('sleeping-composer').hidden`, `${at}the empty sleeping chat is open`, 8000);
            await waitFor(`!!document.querySelector('#live-history-messages > .chat-empty')`, `${at}the empty notice is drawn`, 8000).catch(() => {});
            s = await asleepWords();
            check(/asleep/i.test(s.emptyNotice) || s.emptyNotice === '', `${at}(setup) the empty chat's notice before the wake: ` + JSON.stringify(s.emptyNotice));
            await panelWake('pw-new'); await quiet();
            await waitFor(`document.getElementById('sleeping-composer').hidden === true`, `${at}the empty chat wakes`, 5000).catch(() => {});
            s = await asleepWords();
            check(!s.bar && !/asleep/i.test(s.emptyNotice), `${at}after a panel wake the empty chat no longer says asleep: ` + JSON.stringify(s));

            // 3. opened after the wake
            await ev(`window.__m.add('pw-late', 'L', 20, { sleeping: true })`);
            await select('pw-hist'); // somewhere else while it is woken
            await panelWake('pw-late'); await quiet();
            await select('pw-late');
            await waitFor(`window.__rendered().length > 0`, `${at}the late chat renders`, 8000);
            s = await asleepWords();
            check(!s.bar && !s.wake && !s.inputDisabled, `${at}a chat opened after the wake is awake: ` + JSON.stringify(s));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a panel wake wakes the open chat by itself, and a second Wake starts nothing, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
