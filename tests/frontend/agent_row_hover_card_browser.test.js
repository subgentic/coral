// An agent row's hover card (#9999, the beta tester: "a big Details card over the chat"): it opens after 800 ms of resting on a row, not as the pointer passes; it shows only facts the row does not already show and
// that have a value (no Goal set, No status, a dash, unknown, the team the row sits under, a role that is the agent's name); the keyboard still gets it at once (#9831). 1280 px, a desktop sidebar.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const base = o => Object.assign({ name: 'coral-go', display_name: '', agent_type: 'claude', summary: '', status: '', model: 'claude-opus-5-5', branch: '', repo_name: 'coral', working_directory: '/work/first-agent', server: 'local', board_project: 'beta-team', board_job_title: 'Orchestrator', context_pct: null }, o);
    const labels = () => ev(`(() => { const t = [...document.querySelectorAll('#live-sessions-list .session-tooltip')].find(e => getComputedStyle(e).display === 'block'); return t ? [...t.querySelectorAll('dt')].map(d => d.textContent) : null; })()`);
    const hover = async id => { const r = await ev(`(() => { const b = document.querySelector('#live-sessions-list .session-group-item[data-session-id="${id}"]').getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()`); await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 900, y: 700 }); await sleep(100); await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x, y: r.y }); }; // sleep-ok: the pointer leaves the row first
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([base({ session_id: 'h1', display_name: 'Orchestrator' }), base({ session_id: 'h2', display_name: 'Worker', board_job_title: 'Backend', summary: 'Fix the build', status: 'Running tests', branch: 'feat/x' })])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item').length >= 2`, 'the rows', 6000);
        await hover('h1'); await sleep(300); // sleep-ok: part of the 800 ms the card waits
        check((await labels()) === null, 'the card is not open 300 ms after the pointer reaches a row: ' + JSON.stringify(await labels()));
        await sleep(800); // sleep-ok: the card's own delay
        const quiet = await labels();
        { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/hover-card-quiet.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
        check(Array.isArray(quiet) && quiet.includes('State') && quiet.includes('Agent'), 'it opens once the pointer has rested: ' + JSON.stringify(quiet));
        check(Array.isArray(quiet) && !quiet.some(l => ['Goal', 'Status', 'Branch', 'Context', 'Board', 'Role', 'Name'].includes(l)), 'an agent with no goal, status or branch, an unknown context, a team heading above it and a role that is its name shows none of those rows: ' + JSON.stringify(quiet));
        await hover('h2'); await sleep(1100); // sleep-ok: the card's own delay
        const full = await labels();
        { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/hover-card-full.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
        check(Array.isArray(full) && ['Goal', 'Status', 'Branch', 'Role'].every(l => full.includes(l)), 'an agent that has them shows its goal, status, branch and role: ' + JSON.stringify(full));
        check(Array.isArray(full) && !full.includes('Board') && !full.includes('Name'), 'never the team under whose heading it sits, nor a name the row shows whole: ' + JSON.stringify(full));
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 900, y: 700 }); await sleep(200); // sleep-ok: the card goes
        check((await labels()) === null, 'it goes when the pointer leaves');
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the hover card waits, and shows only what the row does not');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
