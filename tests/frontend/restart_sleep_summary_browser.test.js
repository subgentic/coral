// After Coral restarts, its agents come back asleep (sleep_reason "coral_stopped"); a returning person must be told that, not shown a bare grey "2 sleeping agents" (#10057, Beta Tester #10044 point 2).
// Since #10062 up to three asleep in a team are rows (a returning person sees the agent, not a bare line): each is Sleeping (titled "Asleep since Coral restarted" when Coral stopped it) with its own Wake; four or more
// fold into "4 agents asleep after Coral restarted" with the one Wake for exactly those. 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js (mocked live list and wake) against the isolated dev server.
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
                window.__m.add('big-lead', 'B', 2, { sleeping: false, board_project: 'big-team' });
                for (const n of ['big-1', 'big-2', 'big-3', 'big-4']) window.__m.add(n, 'G', 2, { sleeping: true, sleep_reason: 'coral_stopped', board_project: 'big-team' });
                window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`);
            await sleep(600); // sleep-ok: the list draws over frames
            let r = await rows();
            const byGroup = g => r.find(x => (x.group || '').includes(g));
            const group = g => ev(`[...document.querySelectorAll(${JSON.stringify(LIST)} + ' .session-group-item')].filter(li => (li.dataset.group || '').includes(${JSON.stringify(g)})).map(li => { const b = li.querySelector('.session-name-row > .btn[data-mode="wake"]'), c = li.querySelector('.session-name-row > .chip'); return { name: li.dataset.sessionId, asleep: li.classList.contains('sleeping'), chip: c ? c.textContent.trim() : '', chipTitle: c ? c.title : '', wake: b ? b.getAttribute('aria-label') : null }; })`);
            // #10062: up to three asleep in a team are rows, each with its Sleeping chip (titled when Coral stopped it) and its own Wake; four or more fold into the summary, which says how many came back asleep and wakes those
            const restart = await group('restart-team'), nap = await group('napping-team'), mixed = await group('mixed-team');
            check(`${tag}: two agents asleep after a restart are rows, each Sleeping since Coral restarted, each with its Wake`, restart.filter(x => x.asleep).length === 2 && restart.filter(x => x.asleep).every(x => x.chip === 'Sleeping' && x.chipTitle === 'Asleep since Coral restarted' && /^Wake /.test(x.wake || '')) && !byGroup('restart-team'), JSON.stringify(restart));
            check(`${tag}: an ordinary sleep is a row too, with no restart title`, nap.length === 1 && nap[0].asleep && nap[0].chip === 'Sleeping' && nap[0].chipTitle === '' && !!nap[0].wake, JSON.stringify(nap));
            check(`${tag}: a group with both has a row for each`, mixed.length === 3 && mixed.filter(x => x.asleep).length === 2, JSON.stringify(mixed));
            const big = byGroup('big-team');
            check(`${tag}: four asleep after a restart still fold, and say so, with the one Wake`, big && big.text === '4 agents asleep after Coral restarted' && big.wake === 'Wake', JSON.stringify(r));
            await shot(`restart-sleep-summary-${w}`);
            await ev(`window.__m.requests.length = 0; document.querySelector(${JSON.stringify(LIST)} + ' .session-group-item.sleeping[data-session-id="dev-a-id"] .session-name-row > .btn[data-mode="wake"]').click(); true`);
            await waitFor(`window.__m.requests.filter(q => q.kind === 'wake').length >= 1`, 'the wake', 6000);
            const reqs = await ev(`window.__m.requests.filter(q => q.kind === 'wake').map(q => q.agent).sort()`);
            check(`${tag}: a row's Wake wakes that agent only`, JSON.stringify(reqs) === JSON.stringify(['dev-a']), JSON.stringify(reqs));
            await ev(`window.__m.requests.length = 0; document.querySelector(${JSON.stringify(LIST)} + ' .sleeping-summary-row[data-group*="big-team"] .sleeping-wake').click(); true`);
            await waitFor(`window.__m.requests.filter(q => q.kind === 'wake').length >= 4`, 'the four wakes', 6000);
            const reqs4 = await ev(`window.__m.requests.filter(q => q.kind === 'wake').map(q => q.agent).sort()`);
            check(`${tag}: the folded row's Wake wakes those four`, JSON.stringify(reqs4) === JSON.stringify(['big-1', 'big-2', 'big-3', 'big-4']), JSON.stringify(reqs4));
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} restart-sleep checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
