// #11107 slice 1b: a Pi agent whose Coral extension never reported (the server's hooks-status pi_inactive) shows one quiet chip, "Hooks not active", on its row and nowhere else; it adds no line (the row is as high
// as without it) and states only what is known: the state still comes from Pi's session files. At 1280 px and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const PI = { session_id: 'p1', name: 'pi-agent', display_name: 'Pi Worker', agent_type: 'pi', summary: 'Ship it', model: 'claude-opus-5-5', working_directory: '/work/pi', repo_name: 'pi' };
    const CL = { session_id: 'c1', name: 'claude-agent', display_name: 'Claude Worker', agent_type: 'claude', summary: 'Ship it', model: 'claude-opus-5-5', working_directory: '/work/cl', repo_name: 'cl' };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, h, mobile, list] of [['1280', 1280, 800, false, '#live-sessions-list'], ['390', 390, 844, true, '#mobile-session-list']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            const draw = async () => { await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([PI, CL])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`); if (mobile) await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`); await waitFor(`document.querySelectorAll('${list} .session-group-item').length >= 2`, `${tag}: the rows`, 6000); };
            const probe = () => ev(`(() => { const rows = [...document.querySelectorAll('${list} .session-group-item')]; const of = id => rows.find(r => (r.getAttribute('data-session-id') || r.dataset.sessionId || r.innerHTML).includes(id)); const m = r => r ? { chip: !!r.querySelector('.hooks-inactive-chip'), text: (r.querySelector('.hooks-inactive-chip') || {}).textContent || '', label: (r.querySelector('.hooks-inactive-chip') || { getAttribute() { return ''; } }).getAttribute('aria-label'), h: Math.round(r.getBoundingClientRect().height) } : null; return { pi: m(of('p1')), claude: m(of('c1')) }; })()`);
            await draw();
            const before = await probe();
            assert.ok(before.pi && before.claude, `${tag}: both rows are found: ${JSON.stringify(before)}`);
            assert.ok(!before.pi.chip && !before.claude.chip, `${tag}: no chip by default`);
            await ev(`import((window.__coralStatic || '/static/') + 'hooks_missing.js').then(m => { m.setPiHooksInactive([{ session_id: 'p1' }]); return true; })`);
            await waitFor(`!!document.querySelector('${list} .hooks-inactive-chip')`, `${tag}: the chip`, 6000);
            const after = await probe();
            assert.ok(after.pi.chip && !after.claude.chip, `${tag}: the chip is on the Pi row only: ${JSON.stringify(after)}`);
            assert.equal(after.pi.text, 'Hooks not active');
            assert.match(after.pi.label, /^Hooks not active\. .*Pi's session files/, `${tag}: the chip says what is known and where the state comes from`);
            assert.equal(after.pi.h, before.pi.h, `${tag}: the chip adds no line: ${before.pi.h} px before, ${after.pi.h} px after`);
            await ev(`import((window.__coralStatic || '/static/') + 'hooks_missing.js').then(m => { m.setPiHooksInactive([]); return true; })`);
            await waitFor(`!document.querySelector('${list} .hooks-inactive-chip')`, `${tag}: the chip goes when the extension reports`, 6000);
            console.log(`${tag}: the chip shows on the Pi row only, adds no line, and goes when the extension reports`);
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
