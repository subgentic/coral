// After Coral restarts, its agents come back asleep (sleep_reason "coral_stopped"); a returning person must be told that, not shown a bare grey "2 sleeping agents" (#10057, Beta Tester #10044 point 2).
// The sidebar's folded row says "2 sleeping agents, all after Coral restarted" (no Wake button on the line, #10814; it had one that woke exactly those; an ordinary sleep stays "1 sleeping agent" with no button; a group with both says how many came back
// asleep and wakes only those. 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js (mocked live list and wake) against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    let LIST = '#live-sessions-list'; // a phone's Agents page is its own copy of the list (mobile.js)
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const rows = () => ev(`[...document.querySelectorAll(${JSON.stringify(LIST)} + ' .sleeping-summary-row:not(.archived-summary-row)')].map(r => { const b = r.querySelector('.sleeping-wake'); const rc = b && b.getBoundingClientRect(); return { text: (r.querySelector('.sleeping-summary-label') || r).textContent.trim(), wake: b ? b.textContent.trim() : null, wakeLabel: b ? b.getAttribute('aria-label') : null, wakeH: rc ? Math.round(rc.height) : 0, wakeShown: !!rc && rc.width > 0, rowW: Math.round(r.getBoundingClientRect().width), right: rc ? Math.round(r.getBoundingClientRect().right - rc.right) : null, group: r.dataset.group }; })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`; LIST = mobile ? '#mobile-session-list' : '#live-sessions-list';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => {
                window.__m.add('lead', 'L', 2, { sleeping: false, board_project: 'restart-team' });
                window.__m.add('dev-a', 'A', 2, { sleeping: true, sleep_reason: 'coral_stopped', board_project: 'restart-team' });
                window.__m.add('dev-b', 'B', 2, { sleeping: true, sleep_reason: 'coral_stopped', board_project: 'restart-team' });
                window.__m.add('nap-c', 'C', 2, { sleeping: true, board_project: 'napping-team' });
                window.__m.add('mix-up', 'M', 2, { sleeping: false, board_project: 'mixed-team' });
                window.__m.add('mix-d', 'D', 2, { sleeping: true, sleep_reason: 'coral_stopped', board_project: 'mixed-team' });
                window.__m.add('mix-e', 'E', 2, { sleeping: true, board_project: 'mixed-team' });
                window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`);
            await sleep(600); // sleep-ok: the list draws over frames
            let r = await rows();
            const byGroup = g => r.find(x => (x.group || '').includes(g));
            const restart = byGroup('restart-team'), nap = byGroup('napping-team'), mixed = byGroup('mixed-team');
            check(`${tag}: two agents asleep after a restart say so, with no Wake button on the line (#10814)`, restart && restart.text === '2 sleeping agents, all after Coral restarted' && restart.wake === null, JSON.stringify(r));
            check(`${tag}: an ordinary sleep stays "1 sleeping agent", with no button`, nap && nap.text === '1 sleeping agent' && nap.wake === null, JSON.stringify(nap));
            check(`${tag}: a group with both says how many came back asleep, with no button`, mixed && mixed.text === '2 sleeping agents, 1 after Coral restarted' && mixed.wake === null, JSON.stringify(mixed));
            await shot(`restart-sleep-summary-${w}`);
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} restart-sleep checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
