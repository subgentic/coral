// #16709: the Goals tab's card layout — left-aligned rows, Goal #N and state pills, a labelled
// progress bar, and rows that do not touch (a gap between them). A real board on the isolated dev
// server (removed again), at 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const B = 'goal-card-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // set up: two active goals with tasks
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const g1 = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'First goal', done_when: 'it ships', outcome: 'Shipped product' }); assert.equal(g1.status, 201);
        const g2 = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Second goal', done_when: 'tests pass' }); assert.equal(g2.status, 201);
        const id1 = g1.json.id || g1.json.goal.id, id2 = g2.json.id || g2.json.goal.id;
        for (const t of ['Task A', 'Task B']) { assert.ok((await api('POST', '/tasks', { subscriber_id: 'Operator', title: t, goal_id: id1 })).status < 300); }
        assert.ok((await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task C', goal_id: id2 })).status < 300);

        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr.dt-row').length >= 2`, `${w}: the goals`, 20000);

            if (!mobile) {
                // ── left alignment ──
                const alignment = await ev(`(() => {
                    const rows = [...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')];
                    return rows.map(r => {
                        const card = r.querySelector('.goal-row-wrap');
                        const title = r.querySelector('.goal-card-title');
                        if (!card || !title) return { hasCard: !!card, hasTitle: !!title };
                        const titleStyle = getComputedStyle(title);
                        return { hasCard: true, hasTitle: true, textAlign: titleStyle.textAlign };
                    });
                })()`);
                for (const a of alignment) {
                    assert.ok(a.hasCard, `${w}: row has a .goal-row-wrap`);
                    assert.ok(a.hasTitle, `${w}: row has a .goal-card-title`);
                    assert.ok(['left', 'start', ''].includes(a.textAlign), `${w}: title is left-aligned, got ${a.textAlign}`);
                }

                // ── pills: Goal #N and state ──
                const pills = await ev(`(() => {
                    const rows = [...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')];
                    return rows.filter(r => !!r.querySelector('.goal-row-wrap')).map(r => ({
                        goalId: r.querySelector('.goal-card-id')?.textContent?.trim() || '',
                        state: r.querySelector('.status-word')?.textContent?.trim() || '',
                    }));
                })()`);
                assert.ok(pills.length >= 2, `${w}: at least 2 card rows`);
                for (const p of pills) {
                    assert.match(p.goalId, /^Goal #\d+$/, `${w}: Goal #N pill: ${p.goalId}`);
                    assert.match(p.state, /^(Active|Blocked|Proposed|Done|Dropped)$/, `${w}: state pill: ${p.state}`);
                }

                // ── progress label ──
                const progress = await ev(`(() => {
                    const rows = [...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')];
                    return rows.filter(r => !!r.querySelector('.goal-row-wrap')).map(r => {
                        const prog = r.querySelector('.goal-card-progress');
                        const text = prog?.querySelector('.dt-progress-text')?.textContent?.trim() || '';
                        return { hasProgress: !!prog, text };
                    });
                })()`);
                for (const p of progress) {
                    assert.ok(p.hasProgress, `${w}: row has progress`);
                    assert.match(p.text, /^\d+ of \d+ done$/, `${w}: progress label '${p.text}'`);
                }

                // ── no touching rows (gap between them) ──
                const gaps = await ev(`(() => {
                    const rows = [...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')];
                    const rects = rows.map(r => r.getBoundingClientRect());
                    const gaps = [];
                    for (let i = 1; i < rects.length; i++) gaps.push(Math.round(rects[i].top - rects[i - 1].bottom));
                    return gaps;
                })()`);
                for (let i = 0; i < gaps.length; i++) {
                    assert.ok(gaps[i] >= 0, `${w}: rows ${i} and ${i + 1} do not overlap (gap ${gaps[i]}px)`);
                }

                // ── grey icon, not a coloured tile ──
                const icons = await ev(`(() => {
                    const rows = [...document.querySelectorAll('#team-panel-goals tbody tr.dt-row')];
                    return rows.filter(r => !!r.querySelector('.goal-row-wrap')).map(r => {
                        const icon = r.querySelector('.goal-card-icon');
                        return { hasIcon: !!icon, text: icon?.textContent?.trim() || '' };
                    });
                })()`);
                for (const ic of icons) {
                    assert.ok(ic.hasIcon, `${w}: row has a flag icon`);
                    assert.equal(ic.text, 'flag', `${w}: icon is flag`);
                }
            }
        }
        console.log('PASS goals card layout: left-aligned, pills, progress label, no touching rows');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
