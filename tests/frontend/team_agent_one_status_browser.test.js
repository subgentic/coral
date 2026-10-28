// One status per agent on the team's Agents tab (#10603 point 1, the Beta tester): an agent that is idle with a task in progress said "Task assigned, idle" in the Status column and "#1 in progress" beside it. Now the
// status says "Working on #1" and the task line does not contradict it; the chip is whole (not cut). The board's /status answer is stubbed. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const fs = require('node:fs');
const TEAM = `qa-onestatus-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, availability, reason, tasks) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason, tasks });
                const agents = [a('Worker', 'task_idle', 'Has an assigned task', [{ id: 1, status: 'in_progress', title: 'Write the hours report' }]), a('Waiter', 'task_idle', 'Has an assigned task', [{ id: 2, status: 'pending', title: 'Review it' }]), a('Free One', 'available', 'Idle', [])];
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 3, available: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(600);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 3`, 'the three agents', 8000);
        const all = await ev(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => { const chip = r.querySelector('.dt-chip'); return { status: chip ? chip.textContent.trim() : '', cut: chip ? [chip, ...chip.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1) || chip.getBoundingClientRect().right > chip.closest('td').getBoundingClientRect().right + 1 : null, text: r.innerText.replace(/\\s+/g, ' ') }; })`);
        const rows = { Worker: all.find(r => /Worker/.test(r.text)), Waiter: all.find(r => /Waiter/.test(r.text)) };
        assert.equal(rows['Worker'].status, 'Working on #1', 'an idle agent with a task in progress is "Working on #1": ' + JSON.stringify(rows['Worker']));
        assert.ok(!/Task assigned/.test(rows['Worker'].text), 'no "Task assigned, idle" beside it: ' + rows['Worker'].text);
        assert.equal(rows['Worker'].cut, false, 'the chip is whole: ' + JSON.stringify(rows['Worker']));
        assert.equal(rows['Waiter'].status, 'Task assigned, idle', 'an agent whose task is not started keeps the idle word: ' + JSON.stringify(rows['Waiter']));
        assert.equal(rows['Waiter'].cut, false, 'its chip is whole too: ' + JSON.stringify(rows['Waiter']));
        const shotDir = process.env.CORAL_SCREENSHOT_DIR; const shot = async n => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); fs.writeFileSync(`${shotDir}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        await shot('agents-tab-1280');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await settle(600);
        await shot('agents-tab-390');
        // the filter chips do not count one agent under a status its row does not say: Worker (Working on #1) and Waiter (Task assigned, idle) are both "Has a task"
        const chips = await ev(`[...document.querySelectorAll('.goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.ok(chips.includes('Has a task 2') && !chips.some(c => /Task assigned, idle/.test(c)), 'the filter chip is Has a task, 2: ' + JSON.stringify(chips));
        console.log('PASS one status per agent');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
