// Distill knowledge for ONE agent, not only the whole team (#19560, the Operator). The team's Knowledge tab has "Distill for": All agents (the default: the POST has no body, as it always did) or one member
// (the POST names it: {"session_id": ...}); the choice changes what the hint says; an agent on a team has "Distill knowledge" in its own menu, an agent on no team has none. At 1280 and 390 px the choice is
// inside the page and 44 px tall. The distill route and the team's knowledge are scripted in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-distill-one-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const P = `document.getElementById('team-panel-knowledge')`;
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.__posts = 0; window.__bodies = []; window.__distill = { status: 'none' };
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = String((o && o.method) || 'GET').toUpperCase();
            if (/\\/api\\/teams\\/detail\\/[^/]+\\/distill-knowledge$/.test(url.pathname)) {
                if (m === 'POST') { if (window.__distill.status === 'running') return j(window.__distill); window.__posts++; window.__bodies.push(o.body || null);
                    window.__distill = { status: 'running', progress: { phase: 'starting' }, started_at: new Date().toISOString() }; return j(window.__distill, 202); }
                return j(window.__distill); }
            if (m === 'GET' && /\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname)) return j({ exists: false });
            return R(u, o); }; return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            console.log(w + ' px');
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM); await stub();
            await ev(`window.__m.add('Solo Dev', 'A', 1, { sleeping: false, session_id: 'sid-solo' }); true`);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await ev(`(async () => { const kd = await import((window.__coralStatic || '/static/') + 'knowledge_distill.js'); kd.distillHooks.pollMs = 150; return true; })()`);
            await openTeam(ev, waitFor, TEAM).catch(() => {}); await settle(800);
            await ev(`window.openTeamPage(${JSON.stringify(TEAM)}, { tab: 'knowledge' }); true`);
            await waitFor(`!!${P} && !!${P}.querySelector('#team-distill-who-select') && !/Loading knowledge/.test(${P}.textContent)`, 'the Distill-for choice', 8000);
            const opts = await ev(`[...${P}.querySelectorAll('#team-distill-who-select option')].map(o => o.textContent + '=' + o.value)`);
            assert.deepEqual(opts, ['All agents=', 'Backend Dev=sid-2', 'Orchestrator=sid-1'], w + ': All agents first, then each member of the team (not the agent on no team)');
            assert.equal(await ev(`document.querySelector('label[for=team-distill-who-select]')?.textContent`), 'Distill for');
            const fit = await ev(`(() => { const s = ${P}.querySelector('#team-distill-who-select').getBoundingClientRect(), p = ${P}.getBoundingClientRect(); return { h: s.height, inside: s.right <= p.right + 1 && s.left >= p.left - 1, side: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
            assert.ok(fit.h >= 44 && fit.inside && fit.side, w + ': the choice is 44 px tall and inside the page, nothing runs sideways: ' + JSON.stringify(fit));
            assert.match(await ev(`${P}.querySelector('.team-distill-hint').textContent`), /reads every agent/, 'all agents: the hint is the team one');

            await ev(`${P}.querySelector('.team-distill').click(); true`);
            await waitFor(`window.__posts === 1`, 'the team run', 5000);
            assert.deepEqual(await ev('window.__bodies'), [null], 'All agents posts no body');
            await ev(`window.__distill = { status: 'none' }; true`);
            await waitFor(`!${P}.querySelector('.team-distill').disabled && !!${P}.querySelector('#team-distill-who-select')`, 'the run over', 5000);

            await ev(`(() => { const s = ${P}.querySelector('#team-distill-who-select'); s.value = 'sid-2'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`/reads this agent/.test(${P}.querySelector('.team-distill-hint').textContent)`, 'the one-agent hint', 5000);
            assert.match(await ev(`${P}.querySelector('.team-distill-hint').textContent`), /other agents’ notes and the team’s index stay/);
            await ev(`${P}.querySelector('.team-distill').click(); true`);
            await waitFor(`window.__posts === 2`, 'the one-agent run', 5000);
            assert.equal(await ev('window.__bodies[1]'), JSON.stringify({ session_id: 'sid-2' }), 'one member posts its session');
            await ev(`window.__distill = { status: 'none' }; true`);
            await waitFor(`!${P}.querySelector('.team-distill').disabled`, 'the run over again', 5000);

            // an agent's own menu is on the agents' list: leave the team page first
            await ev(`window.exitTeamPage({ force: true }); true`);
            if (mobile) continue; // the phone's agent list is its own drawer; the menu's markup is the same one
            const row = sid => `document.querySelector('#live-sessions-list li[data-session-id="${sid}"]')`;
            const menu = async sid => { await waitFor(`!!${row(sid)}`, 'the row of ' + sid, 8000); await ev(`${row(sid)}.querySelector('.sidebar-kebab-btn').click(); true`); await waitFor(`!!${row(sid)}.querySelector('[data-on-click="agent-info"]')`, 'the row menu', 6000);
                return ev(`[...${row(sid)}.querySelectorAll('.sidebar-kebab-menu [data-on-click]')].map(b => b.dataset.onClick)`); };
            assert.ok((await menu('sid-solo')).every(a => a !== 'team-distill'), w + ': an agent on no team has no Distill knowledge in its menu');
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            assert.ok((await menu('sid-1')).includes('team-distill'), w + ': an agent on the team has Distill knowledge in its menu');
            await ev(`${row('sid-1')}.querySelector('[data-on-click="team-distill"]').click(); true`);
            await waitFor(`window.__posts === 3`, 'the run from the menu', 8000);
            assert.equal(await ev('window.__bodies[2]'), JSON.stringify({ session_id: 'sid-1' }), 'the menu entry starts a run for that agent');
        }
        console.log('PASS Distill for one agent or all: the tab, the POST body and the agent menu (1280, 390)');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
