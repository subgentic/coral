// Goals uses the width (#7404, UI/UX's #7401): on the Goals face the agent list is the 56 px rail and the right panel is out of the way (a Members button brings it back; each choice is Goals' own and
// remembered), the goal list is 280 to 360 px beside a wide detail (never a strip: under 880 px it stacks under the list), the chips are on one line, the detail takes focus as a region named by its goal
// with no ring, Outcome and Done when sit side by side, a task is one row, and leaving Goals puts the person's own layout back. Measured at 1512, 1280 and 1024 px and on a phone, which keeps its own layout.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;
const { GOALS_STUB } = require('./helpers/goals_stub');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = `goals-layout-${Date.now()}`;
    const box = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; })()`);
    const open = async (w, h, mobile, own = {}) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral.board.face', 'messages'); for (const k of ['coral.goals.agents', 'coral.goals.members']) localStorage.removeItem(k); localStorage.setItem('coral-sidebar-collapsed-rail', '${own.rail || '0'}'); true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(GOALS_STUB);
        await ev(`fetch('/api/board/${board}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'qa', as: 'QA', content: 'hello' }) }).then(() => true)`);
        await ev(`(async () => { const m = await import(${S} + 'message_board.js'); const { showView } = await import(${S} + 'utils.js'); showView('messageboard-view'); m.selectBoardProject(${JSON.stringify(board)}); return true; })()`);
        await waitFor(`document.getElementById('mb-post-input').getClientRects().length > 0`, 'the board', 10000);
    };
    const toGoals = async () => { await ev(`document.getElementById('mb-face-goals').click(); true`); await waitFor(`document.querySelectorAll('#mb-goals .goal-card').length > 0`, 'the goals', 8000); };
    const openGoal = async () => { await ev(`document.querySelector('.goal-card[data-goal-id="1"]').click(); true`); await waitFor(`document.querySelectorAll('#mb-goals .goal-task').length === 3`, 'the goal\'s tasks', 8000); };
    const { framesJs } = require('./helpers/wait');
    const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await ev(framesJs(3)); fs.writeFileSync(require('node:path').join(process.env.CORAL_SCREENSHOT_DIR, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const settle = () => ev(framesJs(2)); // two frames, bounded: the layout classes have been applied and painted
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, minDetail] of [[1512, 900, 800], [1280, 800, 740], [1024, 768, 500]]) {
            const at = `${w} px`;
            console.log(`${at}: Goals takes the width`);
            await open(w, h, false);
            const before = await box('.sidebar');
            await toGoals(); await openGoal(); await settle();
            const side = await box('.sidebar');
            assert.equal(side.w, 56, `${at}: the agent list is the 56 px rail on the Goals face (was ${before.w} px on Messages)`);
            assert.equal(await box('#agentic-state'), null, `${at}: the right panel is out of the way`);
            assert.equal(await ev(`document.body.hasAttribute('data-goals-layout')`), true);
            const list = await box('.goals-list-col'), detail = await box('.goals-detail-col');
            assert.ok(list.w >= 280 && list.w <= 360, `${at}: the goal list is 280 to 360 px wide (got ${list.w})`);
            assert.ok(detail.w >= minDetail, `${at}: the detail is at least ${minDetail} px wide (got ${detail.w}; it was 256 at 1512 and 58 at 1280)`);
            assert.ok(detail.x >= list.r, `${at}: beside the list, not under it`);
            const chips = await ev(`[...document.querySelectorAll('.goals-chip')].map(c => Math.round(c.getBoundingClientRect().top))`);
            assert.ok(chips.length === 6 && chips.every(t => Math.abs(t - chips[0]) <= 1), `${at}: the six chips are on one line: ${JSON.stringify(chips)}`);
            const f = await ev(`(() => { const d = document.getElementById('goals-detail'); return { focus: document.activeElement === d, outline: getComputedStyle(d).outlineStyle, name: d.getAttribute('aria-labelledby'), title: document.getElementById('goals-detail-title').textContent, role: d.tagName }; })()`);
            assert.deepEqual(f, { focus: true, outline: 'none', name: 'goals-detail-title', title: 'Ship the new installer', role: 'SECTION' }, `${at}: the detail has the focus with no ring, named by its goal`);
            const two = await ev(`[...document.querySelectorAll('.goals-two > div')].map(d => { const r = d.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })`);
            assert.ok(two.length === 2 && two[0][1] === two[1][1] && two[1][0] > two[0][0], `${at}: Outcome and Done when sit side by side: ${JSON.stringify(two)}`);
            const row = await ev(`(() => { const li = document.querySelector('.goal-task'); const t = li.querySelector('.goal-task-title').getBoundingClientRect(), b = li.querySelector('.goal-open-task').getBoundingClientRect(), c = li.querySelector('.goal-chip').getBoundingClientRect(); return { sameLine: Math.abs((t.top + t.height / 2) - (b.top + b.height / 2)) < 30 && Math.abs((t.top + t.height / 2) - (c.top + c.height / 2)) < 30, buttonRight: b.left > t.right && b.left > c.left }; })()`);
            assert.deepEqual(row, { sameLine: true, buttonRight: true }, `${at}: a task is one row: its title, its state, Open task at the right`);
            const close = await ev(`(() => { const c = document.querySelector('.goals-close').getBoundingClientRect(), d = document.querySelector('.goals-detail-head').getBoundingClientRect(), h = document.getElementById('goals-detail-title').getBoundingClientRect(); return { right: d.right - c.right < 24, sameRow: c.top < h.bottom }; })()`);
            assert.deepEqual(close, { right: true, sameRow: true }, `${at}: Close goal is at the right of the title row`);
            assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), `${at}: no sideways scroll`);
            await shot(`goals-layout-${w}`);
        }

        console.log('1280 px: Members and the agent list are one click away, remembered, and not the person\'s own layout');
        await open(1280, 800, false, { rail: '0' });
        await toGoals(); await openGoal(); await settle();
        assert.equal(await box('#agentic-state'), null);
        assert.equal(await ev(`document.getElementById('mb-members-btn').getClientRects().length > 0`), true, 'Members is in the header on the Goals face');
        await ev(`document.getElementById('mb-members-btn').click(); true`); await settle();
        assert.ok(await box('#agentic-state'), 'Members shows the right panel');
        await shot('goals-layout-1280-members');
        assert.equal(await ev(`document.getElementById('mb-members-btn').getAttribute('aria-expanded')`), 'true');
        assert.equal(await ev(`localStorage.getItem('coral.goals.members')`), 'open', 'and it is remembered for Goals');
        await ev(`document.getElementById('mb-members-btn').click(); true`); await settle();
        assert.equal(await box('#agentic-state'), null, 'Members again hides it');
        // the agent list: with no agents it stays the rail even when asked; with some it opens, and is remembered
        await ev(`document.querySelector('.sidebar-rail-btn[data-on-click="sidebar-rail-toggle"]').click(); true`); await settle();
        assert.equal((await box('.sidebar')).w, 56, 'an empty agent list never opens wide');
        await ev(`(async () => { const st = (await import(${S} + 'state.js')).state; st.liveSessions = [{ name: 'a', session_id: 'a1', agent_type: 'claude' }]; return true; })()`);
        await ev(`document.querySelector('.sidebar-rail-btn[data-on-click="sidebar-rail-toggle"]').click(); true`); await settle();
        assert.ok((await box('.sidebar')).w > 200, 'with agents it opens');
        await shot('goals-layout-1280-agents');
        assert.equal(await ev(`localStorage.getItem('coral.goals.agents')`), 'wide', 'and is remembered for Goals');
        assert.equal(await ev(`localStorage.getItem('coral-sidebar-collapsed-rail')`), '0', 'the person\'s own rail choice was not written');
        // the Goals area under 880 px stacks the detail under the list at full width
        const stacked = await ev(`(() => { const l = document.querySelector('.goals-list-col').getBoundingClientRect(), d = document.querySelector('.goals-detail-col').getBoundingClientRect(), a = document.getElementById('mb-goals').getBoundingClientRect(); return { area: Math.round(a.width), under: d.top >= l.bottom - 1, detail: Math.round(d.width) }; })()`);
        assert.ok(stacked.area < 880 ? stacked.under && stacked.detail >= 340 : !stacked.under, `under 880 px the detail stacks under the list, never a strip: ${JSON.stringify(stacked)}`);
        console.log('   leaving Goals puts the person\'s own layout back');
        await ev(`localStorage.setItem('coral-sidebar-collapsed-rail', '1'); true`);
        await ev(`document.getElementById('mb-face-messages').click(); true`); await settle();
        assert.equal(await ev(`document.body.hasAttribute('data-goals-layout')`), false);
        assert.equal((await box('.sidebar')).w, 56, 'Messages shows the rail the person chose');
        await ev(`localStorage.setItem('coral-sidebar-collapsed-rail', '0'); document.getElementById('mb-face-goals').click(); document.getElementById('mb-face-messages').click(); true`); await settle();
        assert.ok((await box('.sidebar')).w > 200, 'and the wide list when they chose that');

        console.log('390 px: a phone keeps its own layout');
        await open(390, 844, true);
        await toGoals(); await settle();
        assert.equal(await ev(`document.body.hasAttribute('data-goals-layout')`), false, 'no Goals layout on a phone');
        assert.equal(await ev(`document.getElementById('mb-members-btn').getClientRects().length`), 0, 'no Members button');
        assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), 'no sideways scroll');
        const cols = await ev(`getComputedStyle(document.querySelector('.goals-cols')).gridTemplateColumns.split(' ').length`);
        assert.equal(cols, 1, 'one column');
        await shot('goals-layout-390');
        console.log('PASS goals layout');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
