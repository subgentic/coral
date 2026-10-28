// The new user's path, end to end (#10032): from a fresh page on an isolated server whose agents are the mock in ready mode (MOCK_AGENT_READY=1, #10010: an input box, the first hook event and a canned reply),
//   A. the dashboard loads with New agent in reach (a first-run password offer is declined, not a dead end);
//   B. New agent with its defaults (only the folder typed) launches, the agent is not "starting" for long, and a first message gets a reply in the chat;
//   C. New team with its default members (Orchestrator, Lead Developer, QA Engineer) and a first task launches, and the Orchestrator's chat has that task and a reply.
// Every step has a time budget and the suite fails on any dead end naming the step, what it waited for, and how long it took; the steps run in order, so one dead end is the first thing reported.
// 1280 px, isolated dev server (hooks and the mock are the runner's own: the page changes only cli_path_claude, to a script that starts the mock in ready mode, and puts it back). Not on Windows (a script CLI).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CDP = require('chrome-remote-interface');
const { install: installNT, N: NT, T, openNewTeam, stubModels: stubTeamModels } = require('./helpers/new_team');
const { install: installNA, N: NA, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { removeBoards, removeTeams } = require('./helpers/board_cleanup');

if (process.platform === 'win32') { console.log('new_user_path_browser: SKIPPED, the ready mock is started through a shell script (Coral on Windows has no script CLI here)'); process.exit(0); }

const BUDGET = { load: 30000, launchAgent: 20000, agentReady: 40000, firstReply: 30000, launchTeam: 25000, teamReady: 60000, orchestratorReply: 60000 };
const RUN = String(Date.now() % 1000000);
const TEAM = `newuser-${RUN}`;
const TASK = `Say hello to the team ${RUN}`;
const HELLO = `hello, what can you do? ${RUN}`;
const REPLY = "Hi! I'm mock-agent, a stand-in for a real agent, so this reply is canned.";

(async () => {
    // The real page and the real server: not agent_view_harness, whose page answers the live list from its own stand-in agents (a launched agent would never be listed there).
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady, settle } = require('./helpers/wait').bind(ev);
    const dirs = [], sessions = []; let originalCli = null, wrapperDir = '';
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
    const timeline = [];
    // one step: the work, then its wait, inside a budget; a dead end names the step and what it waited for
    const step = async (name, budget, fn) => {
        const t0 = Date.now();
        let timer; const over = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`DEAD END at "${name}": still not done after ${budget} ms (the budget)`)), budget); });
        try { await Promise.race([fn(), over]); } catch (e) { const m = String(e && e.message || e); throw new Error(m.startsWith('DEAD END') ? m : `DEAD END at "${name}" after ${Date.now() - t0} ms: ${m}`); } finally { clearTimeout(timer); }
        timeline.push([name, Date.now() - t0, budget]); console.log(`   ok   ${name} (${Date.now() - t0} ms of ${budget})`);
    };
    const mkdir = prefix => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; }; // the real path: the list names the folder as the system resolves it (/private/var on a Mac)
    const live = () => ev(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).map(s => ({ id: s.session_id, name: s.name, session_name: s.session_name || '', dir: s.working_directory, board: s.board_project || '', title: s.board_job_title || s.display_name || '', starting: s.starting === true, not_started: s.not_started === true, type: s.agent_type }))`);
    const chat = s => api('GET', `/api/sessions/live/${encodeURIComponent(s.session_name || s.name)}/chat?agent_type=claude&session_id=${encodeURIComponent(s.id)}`).then(r => r.data && r.data.messages || []);
    try {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

        await step('A. the dashboard loads and New agent is in reach', BUDGET.load, async () => {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
            await installNA(ev); await installNT(ev); await stubModels(ev); await stubTeamModels(ev);
            // a first-run offer to set a password is a choice, not a wall: decline it
            await ev(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter(window.__na.vis).find(x => /password/i.test(window.__na.name(x))); const b = d && [...d.querySelectorAll('button')].find(x => /not now|skip|later/i.test(window.__na.name(x))); if (b) b.click(); return true; })()`);
            await waitFor(`typeof window.showLaunchModal === 'function' && [...document.querySelectorAll('button')].some(b => window.__na.vis(b) && /new agent/i.test(window.__na.name(b)))`, 'a visible New agent control', { timeout: BUDGET.load });
        });

        // the mock in ready mode becomes the Claude CLI: a script that starts it with MOCK_AGENT_READY=1; every launch below then reaches Ready and answers
        const settings = await api('GET', '/api/settings');
        originalCli = settings.data && (settings.data.settings || settings.data).cli_path_claude;
        assert.ok(originalCli, 'the runner points cli_path_claude at the mock: ' + JSON.stringify(settings.data && Object.keys(settings.data.settings || settings.data).slice(0, 5)));
        wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-readymock-'));
        const wrapper = path.join(wrapperDir, 'claude');
        fs.writeFileSync(wrapper, `#!/bin/sh\nMOCK_AGENT_READY=1 exec "${originalCli}" "$@"\n`, { mode: 0o755 });
        assert.equal((await api('PUT', '/api/settings', { cli_path_claude: wrapper })).status, 200, 'cli_path_claude set to the ready mock');
        const agentDir = mkdir('coral-newuser-agent-');

        let agent = null;
        await step('B1. New agent: the folder typed, every default kept, Launch is on and the dialog closes', BUDGET.launchAgent, async () => {
            await openNewAgent(ev, waitFor);
            await ev(`(() => { window.__launches = []; const R = window.fetch; window.fetch = async (u, o = {}) => { const r = await R(u, o); if (/\\/api\\/sessions\\/launch/.test(String(u))) { const c = r.clone(); window.__launches.push({ status: r.status, body: (await c.text()).slice(0, 300), sent: String(o.body || '').slice(0, 300) }); } return r; }; return true; })()`);
            await ev(`(() => { const d = window.__na.dialog(); const f = window.__na.find('input', ${NA.folder}); f.value = ${JSON.stringify(agentDir)}; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            for (let i = 0; i < 4; i++) {
                const state = await ev(`(() => { const l = window.__na.find('button', ${NA.launch}); if (l) return { launch: true, off: l.disabled || l.getAttribute('aria-disabled') === 'true' }; const n = window.__na.find('button', ${NA.next}); if (!n) return { stuck: true }; n.click(); return { next: true }; })()`);
                assert.ok(!state.stuck, 'neither Next nor Launch is on screen in New agent');
                if (state.launch) {
                    assert.equal(state.off, false, 'Launch is off with the defaults and nothing says why');
                    await ev(`window.__na.find('button', ${NA.launch}).click(); true`); break;
                }
                await settle(300);
            }
            await waitFor(`!window.__na.dialog()`, 'the New agent dialog closes on a launch', { timeout: BUDGET.launchAgent });
        });
        await step('B2. the agent is listed, opens, and is not "starting" for long', BUDGET.agentReady, async () => {
            try { await waitFor(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(s => s.working_directory === ${JSON.stringify(agentDir)})`, 'the new agent in the live list', { timeout: BUDGET.launchAgent - 2000 }); }
            catch (e) { const srv = await api('GET', '/api/sessions/live'); throw new Error(`${e.message}; the page's list: ${JSON.stringify(await live())}; the server's answer: ${srv.status} ${JSON.stringify(srv.data).slice(0, 500)}; toasts: ${await ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`)}; launch requests: ${JSON.stringify(await ev('window.__launches'))}`); }
            agent = (await live()).find(s => s.dir === agentDir); sessions.push(agent);
            await waitFor(`(() => { const s = (window._coralGetLiveSessions() || []).find(x => x.session_id === ${JSON.stringify(agent.id)}); return !!s && s.starting !== true; })()`, 'the agent to stop "starting" (its first hook event)', { timeout: BUDGET.agentReady });
            const row = (await live()).find(s => s.id === agent.id);
            assert.equal(row.not_started, false, 'the agent says Check terminal (not_started): ' + JSON.stringify(row));
        });
        await step('B3. a first message gets a reply in the chat', BUDGET.firstReply, async () => {
            await ev(`window.selectLiveSession(${JSON.stringify(agent.session_name || agent.name)}, 'claude', ${JSON.stringify(agent.id)}, ''); true`);
            await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the composer', { timeout: 10000 });
            await ev(`(() => { const c = document.getElementById('command-input'); c.focus(); c.value = ${JSON.stringify(HELLO)}; c.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await ev(`(() => { const b = [...document.querySelectorAll('.btn-send')].find(window.__na.vis); if (!b) return false; b.click(); return true; })()`);
            await waitFor(`document.getElementById('live-session-view').textContent.includes(${JSON.stringify(REPLY)})`, 'the canned reply in the chat', { timeout: BUDGET.firstReply });
            assert.equal(await ev(`/isn't ready for messages|was not sent/i.test(document.body.textContent)`), false, 'an error line says the message was not sent');
            const msgs = await chat(agent);
            assert.ok(msgs.some(m => m.type === 'user' && String(m.content || '').includes(HELLO)), 'the message is in the transcript');
        });

        const teamDir = mkdir('coral-newuser-team-');
        await step('C1. New team: its default members, the folder typed, a first task, Launch team is on and the dialog closes', BUDGET.launchTeam, async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(300);
            await openNewTeam(ev, waitFor);
            const t = T(ev, waitFor);
            await t.type('input', NT.teamName, TEAM); await t.type('input', NT.folder, teamDir);
            await t.click('button', NT.next); await t.step(2);
            const roles = await ev(`window.__nt.roles(window.__nt.dlg(${NT.team}))`);
            assert.deepEqual(roles, ['Orchestrator', 'Lead Developer', 'QA Engineer'], 'the default team is in Members');
            await t.click('button', NT.next); await t.step(3);
            await t.type('textarea', /^First task/i, TASK, NT.team);
            const off = await ev(`(() => { const b = window.__nt.buttons(window.__nt.dlg(${NT.team})).find(x => ${NT.launch}.test(x.name)); return b ? b.disabled : null; })()`);
            assert.equal(off, false, 'Launch team is off with the defaults, and the line above the buttons says: ' + await ev(`document.getElementById('team-recap').textContent`));
            await t.click('button', NT.launch);
            await waitFor(`!window.__nt.dlg(${NT.team})`, 'the New team dialog closes on a launch', { timeout: BUDGET.launchTeam });
        });
        let orchestrator = null;
        await step('C2. the Orchestrator is up (not "starting") and the team is open', BUDGET.teamReady, async () => {
            await waitFor(`(window._coralGetLiveSessions() || []).filter(s => s.working_directory === ${JSON.stringify(teamDir)}).length >= 3`, 'the three team agents in the live list', { timeout: BUDGET.launchTeam });
            const rows = (await live()).filter(s => s.dir === teamDir); rows.forEach(r => sessions.push(r));
            orchestrator = rows.find(r => /orchestrator/i.test(r.title) || /orchestrator/i.test(r.name)) || rows[0];
            await waitFor(`(() => { const s = (window._coralGetLiveSessions() || []).find(x => x.session_id === ${JSON.stringify(orchestrator.id)}); return !!s && s.starting !== true; })()`, 'the Orchestrator to stop "starting"', { timeout: BUDGET.teamReady });
        });
        await step("C3. the first task reaches the Orchestrator (a board message or a task) and its chat answers", BUDGET.orchestratorReply, async () => {
            // The first task is the Operator's first message to the lead on the team's board (and, once it is a real task too, a task of the board); the agent is nudged to read it, and the ready mock answers the nudge.
            const board = orchestrator.board;
            assert.ok(board, 'the Orchestrator is on a board: ' + JSON.stringify(orchestrator));
            let msgs = [], posted = false, tasks = [];
            const until = Date.now() + BUDGET.orchestratorReply - 4000;
            while (Date.now() < until) {
                const bm = await api('GET', `/api/board/${encodeURIComponent(board)}/messages/all?limit=50`);
                const list = (bm.data && (bm.data.messages || bm.data)) || [];
                posted = Array.isArray(list) && list.some(m => JSON.stringify(m).includes(TASK));
                const tk = await api('GET', `/api/board/${encodeURIComponent(board)}/tasks`);
                tasks = (tk.data && (tk.data.tasks || tk.data)) || [];
                if (Array.isArray(tasks) && tasks.some(t => JSON.stringify(t).includes(TASK))) posted = true;
                msgs = await chat(orchestrator);
                const nudged = msgs.some(m => m.type === 'user' && /unread message|board/i.test(String(m.content || '')) || (m.type === 'user' && String(m.content || '').includes(TASK)));
                const answered = msgs.some(m => m.type === 'assistant' && JSON.stringify(m).includes(REPLY));
                if (posted && nudged && answered) return;
                await new Promise(r => setTimeout(r, 1000)); // sleep-ok: polling the board and the transcript through the API, no page event says either was written
            }
            throw new Error(`the first task did not reach the Orchestrator: on the board ${posted}; its chat has ${msgs.length} messages: ${JSON.stringify(msgs.map(m => [m.type, String(m.content || m.text || '').slice(0, 50)]))}`);
        });
        console.log('PASS the new user path: ' + timeline.map(([n, ms]) => `${n.split('.')[0]} ${ms} ms`).join(', '));
    } finally {
        for (const s of sessions) { if (s) await api('POST', `/api/sessions/live/${encodeURIComponent(s.session_name || s.name)}/kill`, { session_id: s.id, agent_type: 'claude' }).catch(() => {}); }
        await removeTeams(ev, [TEAM]).catch(() => {}); await removeBoards(ev, [TEAM]).catch(() => {});
        if (originalCli) await api('PUT', '/api/settings', { cli_path_claude: originalCli }).catch(() => {});
        for (const d of dirs.concat(wrapperDir ? [wrapperDir] : [])) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
        await client.close();
    }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
