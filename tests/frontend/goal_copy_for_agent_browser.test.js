// A goal's page has a small quiet "Copy for an agent" button (#11004, Goal #153): it copies one line, "Goal #<id> (<title>): run coral-board goal brief <id>", says it was copied, and sits in the goal's detail line
// (the state and driver row), not in the pinned bar of Add task and Close goal. At 1280 and 390 px. Real board and goal on the isolated dev server (removed again); the clipboard is a stand-in that records the text.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const B = 'gc-' + Date.now().toString(36), TITLE = 'Fast, reliable releases';
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: TITLE, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201);
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        const goalUrl = `/team/${B}/goals/${G}`, want = `Goal #${G} (${TITLE}): run coral-board goal brief ${G}`;
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            console.log(`${at}the copy button copies the line for an agent`);
            await load(goalUrl);
            await waitFor(`document.querySelector('#team-panel-goals #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'the goal', 15000);
            await ev(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); true`);
            const info = await ev(`(() => { const b = document.querySelector('#team-panel-goals .goal-copy-agent'); if (!b) return null; const r = b.getBoundingClientRect(), line = b.closest('.goals-detail-line'); return { text: b.textContent.trim(), inLine: !!line, inPinbar: !!b.closest('.goals-pinbar'), visible: r.width > 0 && r.height > 0, within: r.right <= innerWidth + 1 && r.left >= 0, tall: r.height }; })()`);
            assert.ok(info, at + 'the button is on the goal page');
            assert.equal(info.text, 'Copy for an agent', at + 'its words');
            assert.ok(info.inLine && !info.inPinbar, at + 'in the detail line, not the pinned bar: ' + JSON.stringify(info));
            assert.ok(info.visible && info.within, at + 'visible and inside the screen: ' + JSON.stringify(info));
            if (mobile) assert.ok(info.tall >= 36, at + 'a touch-sized target: ' + info.tall);
            await ev(`document.querySelector('#team-panel-goals .goal-copy-agent').click(); true`);
            await waitFor(`window.__copied.length === 1`, at + 'the text copied', 8000);
            assert.deepEqual(await ev(`window.__copied`), [want], at + 'the line');
            await waitFor(`/Copied/.test(document.body.innerText)`, at + 'the toast says so', 8000);
            await shot(`goal-copy-for-agent-${w}`);
            console.log('   ✓');
        }
        console.log('PASS goal copy for an agent: one line copied, said so, in the detail line, at 1280 and 390');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
