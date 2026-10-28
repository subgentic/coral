// A sleeping agent is a normal row (#10062, the desktop tester: after a restart the asleep Orchestrator was an italic "1 sleeping agent" line, not an agent): up to three asleep in a team stay rows, after the awake ones, with
// the row's one quiet chip, Sleeping, and a Wake button that takes the chip's place at a hover or the keyboard (always on touch; its name says whom it wakes). Four or more in one team fold into "N sleeping agents" as
// before, so a team of nineteen asleep is not a wall of rows. 1280 px, a desktop sidebar.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

const uid = n => '0000' + String(n).padStart(4, '0') + '-0000-4000-8000-000000000000';
const row = (n, o) => Object.assign({ name: 'ag-' + n, session_id: uid(n), agent_type: 'claude', server: 'local', status: 'idle', summary: '', display_name: 'Agent ' + n, working_directory: '/repo/t', branch: '', board_project: 'beta-team', staleness_seconds: 100, working: false, waiting_for_input: false, sleeping: false }, o);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const show = async sessions => { await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(sessions)}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: the list is drawn */ };
    const list = () => ev(`(() => ({ order: [...document.querySelectorAll('#live-sessions-list .session-group-item')].map(li => ({ name: li.querySelector('.session-label-name')?.textContent.trim(), asleep: li.classList.contains('sleeping'), chip: [...li.querySelectorAll('.chip')].map(c => c.textContent.trim()), wake: (() => { const b = li.querySelector('.session-name-row > .btn[data-mode="wake"]'); return b ? { name: b.getAttribute('aria-label'), display: getComputedStyle(b).display } : null; })() })), summary: [...document.querySelectorAll('#live-sessions-list .sleeping-summary-row')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()) }))()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        console.log('1. Two asleep in a team: rows, after the awake one');
        await show([row(1, { sleeping: true }), row(2), row(3, { sleeping: true })]);
        let l = await list();
        check(l.summary.length === 0, 'no folded "sleeping agents" line for two: ' + JSON.stringify(l.summary));
        check(l.order.map(x => x.name).join() === 'Agent 2,Agent 1,Agent 3', 'the awake agent first, then the sleeping ones in their order: ' + JSON.stringify(l.order.map(x => x.name)));
        const asleep = l.order.filter(x => x.asleep);
        check(asleep.length === 2 && asleep.every(x => x.chip.join() === 'Sleeping'), 'each asleep row has the one chip, Sleeping: ' + JSON.stringify(asleep));
        check(asleep.every(x => x.wake && /^Wake Agent \d/.test(x.wake.name) && x.wake.display === 'none'), 'and a Wake button named for the agent, in the chip\'s place only at a hover or the keyboard: ' + JSON.stringify(asleep.map(x => x.wake)));
        check(l.order.filter(x => !x.asleep).every(x => x.wake === null), 'an awake agent has no Wake button');
        await ev(`window.__woke = []; window.toggleAgentSleep = (...a) => { window.__woke.push(a.slice(0, 4)); return Promise.resolve(); }; true`);
        await ev(`document.querySelector('#live-sessions-list .session-group-item.sleeping').focus(); true`); await new Promise(r => setTimeout(r, 100)); // sleep-ok: focus-within applies
        const focused = await ev(`(() => { const li = document.querySelector('#live-sessions-list .session-group-item.sleeping'); const w = li.querySelector('.session-name-row > .btn[data-mode="wake"]'), c = li.querySelector('.session-name-row > .chip'); return [getComputedStyle(w).display, getComputedStyle(c).display]; })()`);
        check(focused[0] !== 'none' && focused[1] === 'none', 'the keyboard on the row shows Wake in the chip\'s place: ' + JSON.stringify(focused));
        await shot('sleeping-rows-two');
        await ev(`document.querySelector('#live-sessions-list .session-group-item.sleeping .session-name-row > .btn[data-mode="wake"]').click(); true`); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the click's handlers run
        const woke = await ev(`window.__woke`);
        check(woke.length === 1 && woke[0][3] === 'wake', 'Wake wakes that agent: ' + JSON.stringify(woke));
        console.log('2. Five asleep: folded as before');
        await show([row(1), row(2, { sleeping: true }), row(3, { sleeping: true }), row(4, { sleeping: true }), row(5, { sleeping: true }), row(6, { sleeping: true })]);
        l = await list();
        check(l.summary.length === 1 && /5 sleeping agents/.test(l.summary[0]), 'five asleep are one line, "5 sleeping agents": ' + JSON.stringify(l.summary));
        check(l.order.filter(x => x.asleep).length === 0, 'and no asleep row is drawn until it is opened: ' + JSON.stringify(l.order.map(x => x.name)));
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS a sleeping agent is a row, up to three');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
