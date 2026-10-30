// The filter pills of the Goals and Tasks tabs at 390 px and at 200% text (#7717, which replaced the strip that scrolled sideways, UI/UX #7453 round 1): they are ONE compact select on the toolbar line, 44 px high, naming
// the chosen pill; choosing another through it presses that pill and keeps the select's value; the two tabs' selects are the same height and nothing scrolls sideways. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-chips-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const sel = () => ev(`(() => { const s = [...document.querySelectorAll('#team-page-view .team-tb-select')].find(e => e.getClientRects().length); if (!s) return null; const pills = document.querySelector('#team-page-view .team-tb-pills'); return { h: Math.round(s.getBoundingClientRect().height), value: s.value, text: s.selectedOptions[0].textContent, options: s.options.length, pillsShown: !!pills && pills.getClientRects().length > 0, side: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await ev(`document.documentElement.style.fontSize = '200%'; true`);
        await seed(ev, TEAM); await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`); await openTeam(ev, waitFor, TEAM); await settle(500);
        let heights = [];
        for (const tab of ['Goals', 'Tasks']) {
            await S.run(`${tab} at 390 px and 200% text: the pills are one compact select, 44 px, nothing scrolls sideways`, async () => {
                await goTab(ev, settle, tab); await settle(300);
                const r = await sel(); assert.ok(r, 'the compact select'); assert.equal(r.pillsShown, false, 'the strip of pills is not shown');
                assert.ok(r.h >= 43.5, `the select is a 44 px target (${r.h})`); assert.ok(r.options >= 5, `it holds every pill (${r.options})`); assert.ok(r.side <= 0, `nothing scrolls sideways (${r.side})`); heights.push(String(r.h));
            });
        }
        await S.run('the Goals and Tasks selects are the same height', async () => { assert.equal(heights[0], heights[1], `Goals ${heights[0]} and Tasks ${heights[1]}`); });
        await S.run('a pill chosen through the select on Tasks is the pressed pill, and the select keeps it', async () => {
            await ev(`(() => { const s = [...document.querySelectorAll('#team-page-view .team-tb-select')].find(e => e.getClientRects().length); s.value = s.options[s.options.length - 1].value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500);
            const r = await sel(); const pressed = await ev(`[...document.querySelectorAll('[role=tabpanel]:not([hidden]) .team-tb-pills .goals-chip[aria-pressed=true]')].map(c => c.dataset.filter)`); // (the Done pill stays pressed with All: the earlier choice of Open or All is a saved view setting)
            assert.ok(pressed.includes(r.value), `the select's value is a pressed pill: ${JSON.stringify({ pressed, value: r.value })}`); assert.ok(/^Done\b/.test(r.text), `and the select names it (${r.text})`);
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
