// Jump to agent (#14565, the Operator): a task's page has a Jump to agent button by Assigned to that opens the agent's chat. Always there when the task names someone and always jumps, even when the agent sleeps
// or is not running (the person lands on its page and wakes it there; the Asleep / Not running word says why); a task in review jumps to its reviewer; a remote agent (Coral Hub) opens on its computer (remote_agent_identity.test.mjs: the team's computer, never an unrelated agent);
// the keyboard (Enter, Space) does the same as a tap; 44 px at 390. Real board on the isolated dev server (removed again); the live agents are the harness's mock sessions. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'jta-' + Date.now().toString(36);
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await ev(`new Promise(r => setTimeout(r, 300))`); /* sleep-ok: the screenshot waits for the layout to settle */ const { data } = await Page.captureScreenshot({ format: 'png' }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from(data, 'base64')); };
    const key = async (k) => { const code = k === 'Enter' ? 13 : 32, text = k === 'Enter' ? '\r' : ' '; await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k === ' ' ? ' ' : k, code: k === 'Enter' ? 'Enter' : 'Space', windowsVirtualKeyCode: code, text }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k === ' ' ? ' ' : k, code: k === 'Enter' ? 'Enter' : 'Space', windowsVirtualKeyCode: code }); };
    const open = async (id) => { await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks', item: ${id} }); true`); await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && document.querySelector('#team-panel-item #team-task-title').textContent.startsWith('#${id} ')`, `task ${id}'s page`, 12000); };
    const jump = () => ev(`(() => { const b = document.querySelector('#team-panel-item .task-jump-btn'); if (!b) return null; const cell = b.closest('.task-jump'), dd = b.closest('dd'), dt = dd.previousElementSibling; const r = b.getBoundingClientRect();
        return { label: b.getAttribute('aria-label'), text: b.textContent, title: b.title, cell: cell.textContent.replace(b.textContent, '|'), fact: dt.textContent, h: Math.round(r.height), w: Math.round(r.width), over: document.documentElement.scrollWidth - innerWidth }; })()`);
    const landed = () => ev(`(() => { const s = window.__qaState.currentSession; return { name: s && s.name, server: s && s.server, agentsTab: !!document.querySelector('#nav-tab-agents.active') }; })()`);
    const leave = async () => { await ev(`window.switchNavTab && window.switchNavTab('teams'); true`).catch(() => {}); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const mk = async (title, assigned) => { const r = await api('POST', `/api/board/${B}/tasks`, { title, body: 'Details for ' + title, assigned_to: assigned, created_by: 'orch', priority: 'medium' }); assert.ok(r.status < 300, JSON.stringify(r)); return r.body.id || r.body.task.id; };
        await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' }); // only an orchestrator makes shared tasks
        for (const id of ['jta-dev', 'jta-sleepy', 'jta-qa']) await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: id, session_name: id + '-s' });
        const run = await mk('Build the jump', 'jta-dev'), sleepy = await mk('Sleeping builder', 'jta-sleepy'), gone = await mk('Builder that ended', 'jta-gone'), rev = await mk('Under review', 'jta-dev'), rev2 = await mk('Reviewer gone', 'jta-dev'), nobody = await mk('Nobody yet', '');
        assert.ok([run, sleepy, gone, rev, rev2].every(Number.isInteger), 'the tasks were made: ' + JSON.stringify([run, sleepy, gone, rev, rev2]));
        const add = (name, o) => ev(`window.__m.add(${JSON.stringify(name)}, 'B', 1, ${JSON.stringify({ board_project: B, board_is_orchestrator: false, board_subscriber_id: name, ...o })}); true`);
        await add('jta-dev', { sleeping: false }); await add('jta-sleepy', { sleeping: true }); await add('jta-qa', { sleeping: false });
        await waitFor(`['jta-dev', 'jta-sleepy', 'jta-qa'].every(n => (window.__qaState.liveSessions || []).some(s => s.name === n))`, 'the agents', 8000);
        // the task read of a task in review, as the server sends it (the reviewers of the round); the page reads the task through fetch
        await ev(`(() => { const real = window.fetch, who = { ${rev}: 'jta-qa', ${rev2}: 'jta-nobody' }; window.fetch = async (u, o) => { const r = await real(u, o); const m = new RegExp('/api/board/${B}/tasks/(\\\\d+)$').exec(String(u)); if (!m || !who[m[1]]) return r; const j = await r.json(); const author = (window.__qaState.liveSessions || []).find(s => s.name === 'jta-dev'); return new Response(JSON.stringify({ ...j, status: 'review_pending', review_requested: true, reviewers: [{ name: who[m[1]] }], session_id: author && author.session_id }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }; return true; })()`);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            console.log(`1. ${tag}: a running agent`);
            await open(run); const j = await jump(); await shot(`jump-running-${w}`);
            check(`${tag}: the button is in the Assigned to row and says Jump to agent`, !!j && j.fact === 'Assigned to' && j.text === 'Jump to agent', JSON.stringify(j));
            check(`${tag}: its accessible name says whose chat it opens`, !!j && j.label === 'Jump to agent: jta-dev', j && j.label);
            check(`${tag}: nothing is wider than the screen`, !!j && j.over <= 0, j && String(j.over));
            if (mobile) check('390 px: the button is a 44 px target', !!j && j.h >= 43.5, j && String(j.h));
            await ev(`document.querySelector('#team-panel-item .task-jump-btn').click(); true`);
            await waitFor(`window.__qaState.currentSession && window.__qaState.currentSession.name === 'jta-dev'`, `${tag}: the agent's page`, 8000);
            check(`${tag}: a tap opens the running agent's page`, (await landed()).name === 'jta-dev' && (await landed()).agentsTab);

            console.log(`2. ${tag}: the keyboard`);
            for (const k of ['Enter', ' ']) {
                await open(run); await ev(`window.__qaState.currentSession = null; document.querySelector('#team-panel-item .task-jump-btn').focus(); true`);
                check(`${tag}: the button takes focus`, await ev(`document.activeElement === document.querySelector('#team-panel-item .task-jump-btn')`));
                await key(k);
                await waitFor(`window.__qaState.currentSession && window.__qaState.currentSession.name === 'jta-dev'`, `${tag}: ${k === ' ' ? 'Space' : 'Enter'} opens the agent`, 8000);
                check(`${tag}: ${k === ' ' ? 'Space' : 'Enter'} opens the agent as a tap does`, (await landed()).name === 'jta-dev');
            }

            console.log(`3. ${tag}: a sleeping agent, an agent that ended, a task nobody has`);
            await open(sleepy); const s = await jump(); await shot(`jump-asleep-${w}`);
            check(`${tag}: a sleeping agent still has the button, with the word Asleep and a tip`, !!s && s.text === 'Jump to agent' && /Asleep/.test(s.cell) && /wake it there/.test(s.title), JSON.stringify(s));
            await ev(`document.querySelector('#team-panel-item .task-jump-btn').click(); true`); await waitFor(`window.__qaState.currentSession && window.__qaState.currentSession.name === 'jta-sleepy'`, `${tag}: the sleeping agent's page`, 8000);
            check(`${tag}: a tap lands on the sleeping agent`, (await landed()).name === 'jta-sleepy');
            await open(gone); const g = await jump(); await shot(`jump-ended-${w}`);
            check(`${tag}: an agent that is not running still has the button, with the word Not running (no hidden state, no Agent ended)`, !!g && /Not running/.test(g.cell) && !/Agent ended/.test(g.cell), JSON.stringify(g));
            await ev(`document.querySelector('#team-panel-item .task-jump-btn').click(); true`); await waitFor(`window.__qaState.currentSession && window.__qaState.currentSession.name === 'jta-gone'`, `${tag}: the ended agent's page`, 8000);
            check(`${tag}: a tap lands on the agent's own page`, (await landed()).name === 'jta-gone');
            await open(nobody); check(`${tag}: a task nobody has has no button`, (await jump()) === null);

            console.log(`4. ${tag}: a task in review`);
            await open(rev); const r = await jump(); await shot(`jump-review-${w}`);
            check(`${tag}: a task in review jumps to the reviewer, named`, !!r && r.label === 'Jump to agent: jta-qa, the reviewer' && /Reviewer: jta-qa/.test(r.cell), JSON.stringify(r));
            await ev(`document.querySelector('#team-panel-item .task-jump-btn').click(); true`); await waitFor(`window.__qaState.currentSession && window.__qaState.currentSession.name === 'jta-qa'`, `${tag}: the reviewer's page`, 8000);
            check(`${tag}: a tap opens the reviewer, not the author`, (await landed()).name === 'jta-qa');
            await open(rev2); const gr = await jump();
            check(`${tag}: a reviewer that is not running is still the target, named`, !!gr && gr.label.startsWith('Jump to agent: jta-nobody, the reviewer') && /Not running/.test(gr.cell), JSON.stringify(gr));
            const authorId = await ev(`(window.__qaState.liveSessions || []).find(s => s.name === 'jta-dev').session_id`);
            await ev(`document.querySelector('#team-panel-item .task-jump-btn').click(); true`); await waitFor(`window.__qaState.currentSession && window.__qaState.currentSession.name === 'jta-nobody'`, `${tag}: the absent reviewer's page`, 8000);
            check(`${tag}: it opens the reviewer by name and never the author's session (the task carries the author's session id)`, await ev(`(() => { const s = window.__qaState.currentSession; return s.name === 'jta-nobody' && s.session_id !== ${JSON.stringify(authorId)}; })()`), JSON.stringify(await landed()));
        }
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
