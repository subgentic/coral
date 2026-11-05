// Automations, the Queue folder's links (#13704, the Operator: "make the agent, the task and the goal a clickable thing here so we can jump to it"): the agent opens its chat (the shared agent link, plain text when it is gone),
// the task opens its page on its board, the goal column shows "#id title" as a link to the goal's page on the team's, a row with no task has neither and a task with no goal has no goal link; the row's Move and Kick are unchanged.
// A phone's card has the same jumps first in its ⋯ menu. Stubbed /api/resources carrying project, goal_id and goal_title as the server sends them. 1280 and 390.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const now = Date.now();
const iso = ms => new Date(now + ms).toISOString();
const QUEUE = [{ name: 'mac-heavy', slots: 1, machine: 'Mac', max_lease_seconds: 3600,
    holders: [{ id: 11, agent: 'Data Science & Dashboarding', task: 13596, project: 'coral-go-team', goal_id: 225, goal_title: 'Resource queue: the Operator sees who waits and why, with a very long title that must be cut', note: 'cdp-suite inbox_*', enqueued_at: iso(-1800000), granted_at: iso(-1700000), lease_until: iso(1500000) }],
    queue: [{ id: 12, agent: 'Frontend Dev', task: 13600, project: 'coral-go-team', note: 'go-test routes', enqueued_at: iso(-600000), place: 1 }, // a task with no goal
        { id: 13, agent: 'Gone Agent', note: 'x', enqueued_at: iso(-300000), place: 2 }] }]; // no task, and not running
const STUB = `(() => { const real = window.fetch; window.__queueTickMs = 1000; window.fetch = (u, o) => /\\/api\\/resources$/.test(String(u)) && (!o || !o.method || o.method === 'GET') ? Promise.resolve(new Response(JSON.stringify({ resources: ${JSON.stringify(QUEUE)} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : real(u, o); })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(async () => { const st = await import(${S} + 'state.js'); st.state.liveSessions = [{ session_id: 'sess-ds', name: 'ds', agent_type: 'claude', board_subscriber_id: 'Data Science & Dashboarding', board_project: 'coral-go-team' }];
                window.__opened = []; window.selectLiveSession = (...a) => { window.__opened.push(['agent', ...a.map(x => (x && x.session_id) || x)]); }; window.openTeamPage = (t, o) => { window.__opened.push(['team', t, JSON.stringify(o)]); return Promise.resolve(); }; window.switchNavTab = (...a) => { window.__opened.push(['nav', ...a.slice(0, 1)]); }; })(); true`);
            await ev(`history.pushState(null, '', '/automations/queue'); window.dispatchEvent(new PopStateEvent('popstate')); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'the three rows', 10000);
            await shot(`queue-links-${process.env.SHOT_TAG || 'after'}-${w}`);
            const row = who => `[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].find(r => r.textContent.includes(${JSON.stringify(who)}))`;
            if (!mobile) {
                // the agent
                assert.equal(await ev(`${row('Data Science')}.querySelector('.queue-agent').tagName`), 'BUTTON', at + 'a running holder is the shared agent link');
                assert.equal(await ev(`${row('Gone Agent')}.querySelector('.queue-agent').tagName`), 'SPAN', at + 'an agent that is gone is text');
                // the task and the goal
                const seen = await ev(`(() => { const vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0; const r = ${row('Data Science')}, a = r.querySelector('.queue-agent'); return { goal: vis(r.querySelector('button.queue-goal')), head: [...document.querySelectorAll('#group-table-view thead th')].some(h => h.textContent.trim() === 'Goal' && vis(h)), agentWhole: a.scrollWidth <= a.clientWidth + 1 }; })()`);
                assert.deepEqual(seen, { goal: true, head: true, agentWhole: true }, at + 'the Goal column is on screen at this width and the longest agent name is not cut: ' + JSON.stringify(seen));
                assert.equal(await ev(`${row('Data Science')}.querySelector('td:nth-child(4) button').textContent`), '#13596', at + 'the task is a link named #id');
                const goal = await ev(`(() => { const b = ${row('Data Science')}.querySelector('button.queue-goal'); return b && [b.textContent, b.getAttribute('aria-label'), b.title]; })()`);
                assert.ok(goal && /^#225 Resource queue/.test(goal[0]) && /^Open goal #225/.test(goal[1]), at + 'the goal is "#id title" as a link: ' + JSON.stringify(goal));
                assert.equal(await ev(`${row('Frontend Dev')}.querySelectorAll('button.queue-goal').length`), 0, at + 'a task with no goal has no goal link');
                assert.equal(await ev(`${row('Gone Agent')}.querySelectorAll('td button.dt-link, button.queue-goal').length`), 0, at + 'a row with no task has neither link');
                // the targets
                await ev(`${row('Data Science')}.querySelector('.queue-agent').click(); true`);
                await ev(`${row('Data Science')}.querySelector('td:nth-child(4) button').click(); true`);
                await ev(`${row('Data Science')}.querySelector('button.queue-goal').click(); true`);
                await waitFor(`window.__opened.length >= 2`, at + 'the clicks reach their targets: ' + JSON.stringify(await ev('window.__opened')), 6000);
                const opened = await ev(`window.__opened`);
                assert.ok(opened.some(o => o[0] === 'team' && o[1] === 'coral-go-team' && /"tab":"tasks"/.test(o[2]) && /13596/.test(o[2])), at + 'the task opens its page on its board: ' + JSON.stringify(opened));
                await waitFor(`window.__opened.some(o => o[0] === 'nav')`, at + "the goal link goes to the team's page (Agents tab first): " + JSON.stringify(await ev('window.__opened')), 6000);
                await waitFor(`/^\\/team\\/coral-go-team\\/goals\\/225/.test(location.pathname)`, at + "the goal opens at its own address on the team's page: " + (await ev('location.pathname')), 8000);
                assert.equal(await ev(`${row('Frontend Dev')}.querySelectorAll('button[aria-label^="Move"], button[aria-label^="Kick"], .queue-act').length > 0`), true, at + 'Move and Kick are still there');
            } else {
                await ev(`${row('Data Science')}.querySelector('.dt-mail-more-toggle').click(); true`);
                await waitFor(`!!document.querySelector('.dt-mail-menu:not([hidden])')`, at + 'the card menu', 4000);
                const items = await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) .menu-item')].map(b => b.textContent.trim())`);
                assert.deepEqual(items.slice(0, 3), ['Open Data Science & Dashboarding', 'Task #13596', 'Goal #225'], at + 'the card starts with the three jumps: ' + JSON.stringify(items));
            }
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
        }
        console.log('PASS the Queue folder links: agent, task, goal, none, 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
