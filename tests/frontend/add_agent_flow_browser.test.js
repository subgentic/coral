// Add agent is New Agent's own dialog with the team preset (#7778, the operator: "the +Add Agent from the team dropdown should have the select persona -> Next button, then the agent selection screen
// with permissions etc., similar to how New Agent works"). From the team page's header button and from the team's dropdown entry the dialog opens on the persona step (the team's folder is known, so there
// are two steps: persona, then the agent), names the team in its title, joins it by id without showing a field that could change it, and sends the body Add agent always sent. A team with no folder keeps
// New Agent's folder step. Closing it leaves New Agent as it was. 1280 and 390 px, keyboard. A real board on the isolated dev server; only the launch request is answered by the test.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

const TEAM = `addagent-${Date.now() % 100000}`;
const DIR = '/work/crew';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const OPEN = `(() => { const m = document.getElementById('launch-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`; // the dialog's markup is lazy: not there until it is first asked for
    const stage = () => ev(`document.getElementById('launch-step-agent').dataset.stage`);
    const modalOpen = () => ev(`getComputedStyle(document.getElementById('launch-modal')).display !== 'none'`);
    const sub = () => ev(`document.getElementById('launch-stage-sub').textContent.replace(/\\s+/g, ' ').trim()`);
    const title = () => ev(`document.getElementById('launch-agent-title-text').textContent`);
    const vis = id => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && getComputedStyle(e).display !== 'none' && !e.hidden && e.getClientRects().length > 0; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280 px', 1280, 800, false], ['390 px', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            await ev(`(() => { window.__launches = []; const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                    if (p.pathname === '/api/sessions/launch' && m === 'POST') { window.__launches.push(JSON.parse(o.body)); return json({ session_name: 's1', session_id: 'sid-s1' }); }
                    if (p.pathname === '/api/system/cli-check') return json({ found: true, version: '1' });
                    return real(u, o); }; return true; })()`);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {}); await settle(400);

            // the header button: the team's folder is the one of its live agents (the seeded ones work in /tmp/Orchestrator), so the dialog opens on the persona step
            await ev(`window.__calls = []; { const real = window.showAddAgentToBoard; window.showAddAgentToBoard = (...a) => { window.__calls.push(a); return real(...a); }; } true`);
            await ev(`document.getElementById('team-page-add-agent').click(); true`);
            await waitFor(`${OPEN} && document.getElementById('launch-step-agent').dataset.stage === 'persona'`, `${label}: the dialog from the header button, on the persona step`);
            const called = await ev(`window.__calls.map(a => [a[0], a[1]])`);
            assert.equal(called.length, 1, `${label}: one open`); assert.equal(called[0][0], TEAM, `${label}: the header button opens Add agent for the team`); assert.ok(called[0][1], `${label}: with the team's folder`);
            assert.equal(await title(), `Add agent to ${TEAM}`, `${label}: the team is named in the title`);
            await ev(`window.hideLaunchModal(); true`); await settle(150);

            // a team with no folder keeps New Agent's folder step, three steps, the team still preset
            await ev(`window.showAddAgentToBoard(${JSON.stringify(TEAM)}, ''); true`);
            await waitFor(`${OPEN} && document.getElementById('launch-step-agent').dataset.stage === 'folder'`, `${label}: a team with no folder starts on the folder`);
            assert.equal(await title(), `Add agent to ${TEAM}`);
            assert.match(await sub(), /^Step 1 of 3: Where it launches/);
            assert.equal(await vis('launch-board-select'), false, `${label}: the team cannot be changed: the Message Board field is not there`);
            await ev(`window.hideLaunchModal(); true`); await settle(150);

            // the dropdown's entry, with the team's folder
            await ev(`window.__setDir = ${JSON.stringify(DIR)}; true`);
            await ev(`(() => { const b = document.createElement('button'); b.id = 'qa-team-add'; b.type = 'button'; b.dataset.onClick = 'team-add-agent'; b.dataset.board = ${JSON.stringify(TEAM)}; b.dataset.dir = ${JSON.stringify(DIR)}; document.body.append(b); b.click(); return true; })()`);
            await waitFor(`${OPEN} && document.getElementById('launch-step-agent').dataset.stage === 'persona'`, `${label}: the dialog from the dropdown, on the persona step`);
            assert.equal(await title(), `Add agent to ${TEAM}`);
            assert.match(await sub(), new RegExp(`^Step 1 of 2: Persona\\. In ${DIR}`), `${label}: two steps, the folder is the team's`);
            assert.equal(await vis('launch-agent-back'), false, `${label}: nothing is before the persona step`);
            assert.equal(await vis('launch-agent-next'), true);
            assert.equal(await ev(`getComputedStyle(document.querySelector('#launch-step-agent .launch-back-btn')).display`), 'none', `${label}: no way back to the chooser`);
            assert.equal(await ev(`document.activeElement && document.activeElement.classList.contains('agent-preset-select')`), true, `${label}: the persona list has the keyboard`);
            assert.equal(await vis('launch-board-select'), false, `${label}: the team is fixed`);
            assert.equal(await ev(`document.getElementById('launch-board-select').value`), TEAM, `${label}: and it is the one joined`);
            if (mobile) {
                const fit = await ev(`(() => { const c = document.querySelector('#launch-modal .modal-content').getBoundingClientRect(); const n = document.getElementById('launch-agent-next').getBoundingClientRect(); return { w: c.width, vw: innerWidth, h: n.height, inside: n.bottom <= innerHeight && n.right <= innerWidth, side: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
                assert.ok(fit.w <= fit.vw + 1 && fit.h >= 44 && fit.inside && fit.side, `${label}: the dialog fits the phone and Next is a 44 px target: ` + JSON.stringify(fit));
            }
            // persona step -> Next -> the agent screen with its sections; Back returns to the persona
            await ev(`{ const n = document.getElementById('launch-agent-name-input'); n.value = 'Bo'; n.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('launch-agent-next').click(); } true`);
            await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent'`, `${label}: the agent screen`);
            assert.match(await sub(), /^Step 2 of 2: The agent/);
            assert.equal(await vis('launch-agent-back'), true); assert.equal(await vis('launch-agent-go'), true, `${label}: Launch is on the agent screen`);
            assert.ok(await ev(`!!document.querySelector('#launch-step-agent .settings-tab') && [...document.querySelectorAll('#launch-step-agent .settings-tab')].some(t => /Permissions/i.test(t.textContent))`), `${label}: the agent screen has its Permissions section`);
            await ev(`document.getElementById('launch-agent-back').click(); true`);
            assert.equal(await stage(), 'persona', `${label}: Back returns to the persona`); assert.equal(await vis('launch-agent-back'), false, `${label}: and no further`);
            await ev(`document.getElementById('launch-agent-next').click(); true`);
            await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent'`, `${label}: the agent screen again`);

            // the launch: the body Add agent always sent (no backend, the team joined by id, no remote board server)
            await ev(`document.getElementById('launch-agent-go').click(); true`);
            await waitFor(`window.__launches.length === 1`, `${label}: the launch`);
            const sent = await ev(`window.__launches[0]`);
            assert.equal(sent.working_dir, DIR); assert.equal(sent.display_name, 'Bo'); assert.equal(sent.board_id, TEAM); assert.equal(sent.board_name, TEAM);
            assert.ok(Array.isArray(sent.flags) || sent.flags === undefined);
            const allowed = new Set(['working_dir', 'agent_type', 'display_name', 'flags', 'prompt', 'board_id', 'board_name', 'model', 'thinking', 'capabilities']);
            assert.deepEqual(Object.keys(sent).filter(k => !allowed.has(k)), [], `${label}: nothing but what Add agent sent: ` + JSON.stringify(Object.keys(sent)));
            await waitFor(`!(${OPEN})`, `${label}: the dialog closes`);

            // New Agent is as it was: its own title, the three steps, the Message Board field
            await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`); await settle(200);
            assert.equal(await title(), 'New agent'); assert.equal(await stage(), 'folder'); assert.match(await sub(), /^Step 1 of 3:/);
            assert.equal(await ev(`document.getElementById('launch-modal').hasAttribute('data-add-to')`), false);
            assert.equal(await ev(`document.getElementById('launch-board-select').closest('.form-row').hidden`), false, `${label}: New Agent still offers the Message Board`);
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('PASS add_agent_flow');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
