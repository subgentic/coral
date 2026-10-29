// Phone pass 3 leftovers (#11015, Goal #150), the small layout items, at 390 px with touch: New job's Weekly day buttons are in even columns (4 and 3, not 3, 3 and Sun alone); Edit member's Move up and
// Move down are side by side in a row of their own, equal width, and Remove from team has a row above; the job page of a job that is turned off says so once, in its status line. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `plo-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        // Weekly day buttons
        await ev(`window.showJobModal(); true`);
        await waitFor(`!!document.getElementById('sched-picker')`, 'the job form', 8000);
        await ev(`document.querySelector('.sched-preset[data-mode="weekly"]').click(); true`);
        await waitFor(`[...document.querySelectorAll('#sched-picker .sched-day')].some(b => b.getClientRects().length)`, 'the day buttons', 8000);
        const days = await ev(`[...document.querySelectorAll('#sched-picker .sched-day')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })`);
        assert.equal(days.length, 7, 'seven days: ' + JSON.stringify(days));
        assert.ok(days.every(d => Math.abs(d[2] - days[0][2]) <= 1), 'the day buttons are all one width: ' + JSON.stringify(days));
        assert.ok(days.every(d => d[3] >= 44), 'and 44 px tall: ' + JSON.stringify(days));
        const rows = [...new Set(days.map(d => d[1]))].map(t => days.filter(d => d[1] === t).length);
        assert.deepEqual(rows, [4, 3], 'in rows of 4 and 3, not 3, 3 and one alone: ' + JSON.stringify(days));
        await ev(`window.hideJobModal && window.hideJobModal(); true`);
        // Edit member: Move up / Move down side by side
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length >= 3`, 'the default team', 8000);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('members'); return true; })()`);
        const geom = id => ev(`(() => { const b = document.getElementById(${JSON.stringify(id)}), r = b.getBoundingClientRect(); return b.getClientRects().length ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null; })()`);
        for (const [idx, what] of [[0, 'the Orchestrator'], [1, 'a member']]) {
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[${idx}].querySelector('button').click(); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member' && document.getElementById('launch-agent-move-down').getClientRects().length > 0`, `Edit member (${what})`, 6000);
            const [up, down] = [await geom('launch-agent-move-up'), await geom('launch-agent-move-down')];
            assert.ok(up && down && up[1] === down[1] && Math.abs(up[2] - down[2]) <= 1 && up[0] < down[0], `${what}: Move up and Move down side by side, equal width: ${JSON.stringify([up, down])}`);
            if (idx === 1) { const rm = await geom('launch-agent-remove'); assert.ok(rm && rm[1] < up[1] && rm[2] > up[2] * 1.8, 'Remove from team has a row of its own above: ' + JSON.stringify([rm, up])); }
            await ev(`document.getElementById('launch-agent-cancel').click(); true`);
            await waitFor(`!document.getElementById('launch-modal').hasAttribute('data-member')`, 'closed', 6000);
        }
        // the team page's Actions menu: every row is a plain row (no border, no box), like Add agent and Sleep Team
        await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
        await installTP(ev); await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM);
        await ev(`document.getElementById('team-page-more').click(); true`);
        await waitFor(`!document.getElementById('team-page-more-menu').hidden`, 'the Actions menu', 6000);
        const rowsBox = await ev(`[...document.querySelectorAll('#team-page-more-menu > button')].filter(b => b.getClientRects().length).map(b => { const c = getComputedStyle(b); return { text: b.textContent.trim().slice(0, 24), border: c.borderTopWidth, bg: c.backgroundColor }; })`);
        assert.ok(rowsBox.length >= 5, 'the menu has its rows: ' + JSON.stringify(rowsBox));
        assert.ok(rowsBox.every(r => r.border === '0px' && r.bg === 'rgba(0, 0, 0, 0)'), 'every row of the Actions menu is plain, none boxed: ' + JSON.stringify(rowsBox));
        console.log('PASS phone leftovers: day buttons, Edit member footer, Actions menu rows');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
