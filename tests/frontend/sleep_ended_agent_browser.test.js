// #15068 (the Operator): an agent whose CLI ended (the "Ended" chip, Wake) stayed among the live agents and had no way to move into the sleeping group: its menu had no Sleep. Ended stays in view on purpose (#6058: it
// needs a Restart, not a nap), so the way out is the one a terminal-gone agent has (#13171): a Sleep button on its row and a Sleep item in its menu. Sleep files it under sleeping (no Ended chip, Wake still on it).
// A plain sleeper, an awake agent and an archived agent are unchanged. Both are real buttons, so the keyboard and a screen reader reach them (the row's button is named for the agent).
//
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const { coralReady, framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired();
        await install();
        await coralReady(ev);
        await ev(`(async () => {
            window.__m.add('ended-1', 'E', 3, { sleeping: true, sleep_reason: 'agent_exited', board_project: 'end-team' });
            // four plain sleepers fold into the "N sleeping agents" row, so a filed agent is seen to leave the list
            for (const n of ['nap-1', 'nap-2', 'nap-3', 'nap-4']) window.__m.add(n, 'N', 3, { sleeping: true, board_project: 'end-team' });
            window.__m.add('busy', 'B', 3, { sleeping: false, board_project: 'end-team' });
            window.__calls = [];
            const f = window.fetch;
            window.fetch = (url, opts = {}) => {
                const m = String(url).match(/\\/api\\/sessions\\/live\\/([^/?]+)\\/sleep$/);
                if ((opts.method || 'GET') === 'POST' && m) {
                    window.__calls.push(decodeURIComponent(m[1]));
                    return Promise.resolve(new Response(JSON.stringify({ ok: true, sleeping: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                }
                return f(url, opts);
            };
            window.T.render.renderLiveSessions(window.T.state.liveSessions);
            return true;
        })()`);
        const rowInfo = id => ev(`(() => { const li = document.querySelector('.session-group-item[data-session-id="${id}"]'); if (!li) return null;
            const btn = [...li.querySelectorAll('button')].find(b => b.dataset.mode === 'sleep');
            return { chip: (li.querySelector('.terminal-gone-chip') || {}).textContent || '', sleepBtn: btn ? { text: btn.textContent.trim(), aria: btn.getAttribute('aria-label'), tag: btn.tagName, disabled: btn.disabled } : null }; })()`);

        for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await ev(`window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
            await ev(framesJs(2));
            const r = await rowInfo('ended-1-id');
            assert.ok(r && r.chip === 'Ended', `${width}: the ended agent is a row with its Ended chip: ${JSON.stringify(r)}`);
            assert.ok(r.sleepBtn && r.sleepBtn.text === 'Sleep' && r.sleepBtn.tag === 'BUTTON' && !r.sleepBtn.disabled && /^Put .+ to sleep$/.test(r.sleepBtn.aria), `${width}: a Sleep button named for the agent: ${JSON.stringify(r.sleepBtn)}`);
            for (const id of ['busy-id']) {
                const o = await rowInfo(id);
                assert.ok(!o || o.sleepBtn === null, `${width}: ${id} has no Sleep button`);
            }
        }
        console.log('   ✓ row: an Ended agent has a Sleep button named for it; an awake agent has none');

        const menu = id => ev(`(() => { const li = document.querySelector('.session-group-item[data-session-id="${id}"]'); window.closeSidebarKebabs(); li.querySelector('.sidebar-kebab-btn').click();
            return [...li.querySelectorAll('.sidebar-kebab-menu .overflow-menu-item')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()); })()`);
        const items = await menu('ended-1-id');
        assert.ok(items.includes('Sleep') && items.includes('Wake'), `the menu of an Ended agent offers Sleep and Wake: ${JSON.stringify(items)}`);
        await ev(`window.closeSidebarKebabs(); true`);
        console.log('   ✓ menu: Sleep beside Wake for an Ended agent');

        // Sleep files it: one request for it, no Ended chip, no row among the live agents (the sleeping group has it)
        await ev(`document.querySelector('.session-group-item[data-session-id="ended-1-id"] button[data-mode="sleep"]').click(); true`);
        await ev(framesJs(3));
        assert.deepEqual(await ev(`window.__calls`), ['ended-1-id'], 'one Sleep request, for that agent');
        const after = await ev(`(() => { const row = document.querySelector('.session-group-item[data-session-id="ended-1-id"]');
            const s = window.T.state.liveSessions.find(x => x.session_id === 'ended-1-id');
            return { rowStillListed: !!row, reason: s.sleep_reason, sleeping: s.sleeping, summary: (document.querySelector('.sleeping-summary-row') || {}).textContent || '' }; })()`);
        assert.equal(after.rowStillListed, false, 'it left the live list: it is in the sleeping group now');
        assert.equal(after.reason, null, 'it is a plain sleeper, not Ended');
        assert.match(after.summary.replace(/\s+/g, ' '), /5 sleeping agents/, `the sleeping group counts it: ${after.summary}`);
        console.log('   ✓ Sleep files the Ended agent under sleeping, without its Ended chip');
    } finally {
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
