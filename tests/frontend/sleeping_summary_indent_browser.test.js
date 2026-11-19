// The sidebar's "N sleeping agents" line (Operator, 2026-11-19, from a shot): it sat at team indent in a grey box, so it read as another team. It is one of the team's agent rows: its moon where an agent's status dot is,
// its words where an agent's name is, and no box of its own at rest. 1280 px, through agent_view_harness: a team with one awake agent and four asleep (they fold into the line).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, sleep, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); // sleep-ok: the page settles before a screenshot
            fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__m.add('lead', 'L', 2, { sleeping: false, board_project: 'indent-team' });
            for (const n of ['s-1', 's-2', 's-3', 's-4']) window.__m.add(n, 'G', 2, { sleeping: true, sleep_reason: 'coral_stopped', board_project: 'indent-team' });
            window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
        await sleep(600); // sleep-ok: the list draws over frames
        const m = await ev(`(() => { const L = '#live-sessions-list ', x = (el, sel) => { const e = el && el.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().left) : null; };
            const row = document.querySelector(L + '.session-group-item:not(.sleeping)'), sum = document.querySelector(L + '.sleeping-summary-row:not(.archived-summary-row)');
            return { dot: x(row, '.session-dot'), name: x(row, '.session-label'), moon: x(sum, 'svg'), label: x(sum, '.sleeping-summary-label'), rowLeft: Math.round(row.getBoundingClientRect().left), sumLeft: Math.round(sum.getBoundingClientRect().left), bg: getComputedStyle(sum).backgroundColor, text: sum.textContent.trim() }; })()`);
        console.log(JSON.stringify(m));
        await shot('sleeping-summary-indent');
        assert.equal(m.text, '4 sleeping agents, all after Coral restarted');
        assert.ok(Math.abs(m.moon - m.dot) <= 2, `the moon sits where an agent's dot does: moon ${m.moon}, dot ${m.dot}`);
        assert.ok(Math.abs(m.label - m.name) <= 2, `the words sit where an agent's name does: label ${m.label}, name ${m.name}`);
        assert.ok(/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(m.bg), `no box at rest: ${m.bg}`);
        console.log('PASS the sleeping-agents line is indented like the team\'s agent rows and has no box at rest');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
