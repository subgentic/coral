// An archived agent on the team's Agents tab (#19674, the Operator's three states: Awake, Asleep, Archived): it is out of the default list and the count, More > Archived lists it, and its page has Start (the wake call: back
// awake) and Sleep (the unarchive call: asleep, back in the list). The board's /status and the two calls are stubbed. 1280 px, through the real team page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-arch-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        const sid = await ev(`(window.__LIVE.find(s => s.name === 'Backend Dev') || {}).session_id`);
        assert.ok(sid, 'the seeded team has a Backend Dev session');
        await ev(`(() => { window.__calls = []; window.__state = 'archived'; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, availability, extra = {}) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason: availability, tasks: [], ...extra });
                const agents = [a('Orchestrator', 'available'), a('Backend Dev', window.__state, { session_id: ${JSON.stringify(sid)} })];
                return json({ agents, summary: { total: 2 } }); }
            if (o.method === 'POST' && url.pathname === '/api/sessions/live/${sid}/unarchive') { window.__calls.push('unarchive'); window.__state = 'sleeping'; return json({ ok: true, sleeping: true, archived: false }); }
            if (o.method === 'POST' && url.pathname === '/api/sessions/live/${sid}/wake') { window.__calls.push('wake'); window.__state = 'available'; return json({ ok: true, sleeping: false }); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(500);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`!![...document.querySelectorAll('tr.dt-row')].find(r => r.innerText.includes('Orchestrator'))`, 'the agents are rows', 8000);
        const rows = () => ev(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => r.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40))`);
        assert.ok(!(await rows()).some(t => /Backend Dev/.test(t)), 'an archived agent is not in the default list');
        assert.equal(await ev(`(document.querySelector('.team-agents-count') || {}).textContent`), '1 agent', 'and not in the count');
        const pickArchived = () => ev(`(() => { const s = document.querySelector('.team-tb-more'); const o = [...s.options].find(o => /^Archived/.test(o.textContent.trim())); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        for (const [word, call, state] of [['Sleep', 'unarchive', 'sleeping'], ['Start', 'wake', 'available']]) {
            await ev(`window.__state = 'archived'; window.__calls = []; true`);
            await ev(`window.dispatchEvent(new Event('kill')); true`); // the open tab reads its rows again
            await waitFor(`!![...document.querySelectorAll('.team-tb-more option')].find(o => /^Archived/.test(o.textContent.trim()))`, 'More > Archived has the agent', 8000);
            await pickArchived();
            await waitFor(`!![...document.querySelectorAll('tr.dt-row')].find(r => r.innerText.includes('Backend Dev'))`, 'Archived lists it', 8000);
            await ev(`[...document.querySelectorAll('tr.dt-row')].find(r => r.innerText.includes('Backend Dev')).querySelector('.dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('.goals-pinbar')`, 'its page (an archived agent\'s row opens its page, not a chat)', 8000);
            await waitFor(`!!document.querySelector('button[aria-label="${word} Backend Dev"]')`, `its page has ${word}`, 8000);
            assert.ok(await ev(`!!document.querySelector('button[aria-label="Start Backend Dev"]') && !!document.querySelector('button[aria-label="Sleep Backend Dev"]')`), 'Start and Sleep are both there');
            await ev(`document.querySelector('button[aria-label="${word} Backend Dev"]').click(); true`);
            await waitFor(`window.__calls.length === 1`, `${word} makes the ${call} call`, 8000);
            assert.deepEqual(await ev('window.__calls'), [call]);
            await waitFor(`!document.querySelector('button[aria-label="${word} Backend Dev"]')`, 'the page goes back to the list', 8000);
            await ev(`window.__state === ${JSON.stringify(state)}`);
        }
        console.log('PASS an archived agent is out of the list and count, found under More > Archived, and Start and Sleep are the wake and unarchive calls');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
