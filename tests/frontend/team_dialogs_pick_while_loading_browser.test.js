// The New team form's template choice follows a pick made while the form is still loading (#9911, found in review): on a second opening the template list is already drawn, so a person can pick Coding Team
// while the board names load; the form's async step used to run resetTeamTemplatePicker() and mark Default team afterwards, so the choice said "Default team (3 members)" over the picked team's seven members.
// The request for the board names is held by the test and released after the pick. Isolated dev server; run_cdp_suites.mjs finds it by name.
// The team dialogs (#4684): the team form of the Launch dialog (its starting agents, the board-name hint, adding, moving and removing agents), the templates (load a built-in, save one, the saved one
// in the list), the team-agent dialog (add and edit, a name is required), the AI team wizard (a directive and a composition are required, a failed request, a finished job reviewed in the form)
// and Launch Team (its request, a board that exists, an agent that failed). They are blocks of modals.js; this pins what they do before they move into their own module. Drives Chrome over CDP
// through agent_view_harness.js against the isolated dev server; every request is answered by the test.
const assert = require('node:assert/strict');
const { removeBoards } = require('./helpers/board_cleanup');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings(); // the settings this suite changes are put back in its finally (#4849)
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => {
            window.__teamLaunches = []; window.__posts = []; window.__entered = []; window.__generates = []; window.__templates = []; window.__boards = ['taken'];
            window.__launchAnswer = { status: 200, body: { agents: [{ name: 'A', session_id: 's' }] } };
            window.__generateAnswer = { status: 200, body: { error: 'the model is down' } };
            window.__jobAnswer = { status: 'pending' };
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                if (p.pathname === '/api/sessions/launch-team' && m === 'POST') { window.__teamLaunches.push(JSON.parse(o.body)); return json(window.__launchAnswer.body, window.__launchAnswer.status); }
                if (p.pathname === '/api/teams/generate' && m === 'POST') { window.__generates.push(JSON.parse(o.body)); return json(window.__generateAnswer.body, window.__generateAnswer.status); }
                if (p.pathname.startsWith('/api/teams/generate/')) return json(window.__jobAnswer);
                if (p.pathname.startsWith('/api/board/crew-1') && p.pathname.endsWith('/messages') && m === 'POST') { window.__posts.push({ ...JSON.parse(o.body), path: p.pathname }); return json({ id: 1 }, window.__postStatus || 200); }
                if (p.pathname === '/api/board/projects') { const out = json(window.__boards.map(b => ({ project: b }))); return window.__hold ? new Promise(r => { window.__release = () => r(out); }) : out; }
                if (p.pathname === '/api/filesystem/is-git') return json({ is_git: p.searchParams.get('path') === '/work/repo' });
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal();
            return true; })()`);
        const teamRows = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => r.querySelector('.team-agent-role-name').textContent)`);
        const hint = () => ev(`(() => { const h = document.getElementById('team-board-name-hint'); return [h.textContent, document.getElementById('team-board-name').getAttribute('aria-invalid') === 'true']; })()`); // the notice under the name, and whether the name is flagged (its error line is the form's)
        const toasts = () => ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent.trim())`);
        const openTeam = async () => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
        };
        const state = () => ev(`(() => { const s = document.getElementById('team-template-select'); return [s.options[s.selectedIndex].textContent, document.querySelectorAll('#team-agents-list .team-agent-row').length]; })()`);
        // first opening, nothing held: the picker's options are drawn
        await openTeam(); await waitFor(`document.querySelectorAll('#team-template-select option').length > 2`, 'the options', 6000);
        await ev(`window.hideLaunchModal(); true`);
        // second opening while the board names load: the options of the first opening are still there, and a person can pick one
        await ev(`window.__hold = true; window.showLaunchModal(); window._selectLaunchType('team'); true`);
        await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length >= 1`, 'the default members', 6000);
        const opts = await ev(`[...document.querySelectorAll('#team-template-select option')].map(o => [o.value, o.textContent])`);
        const pick = opts.find(o => o[0] && o[0] !== '__default');
        await ev(`(() => { const s = document.getElementById('team-template-select'); s.value = ${JSON.stringify(pick[0])}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const before = await state();
        await ev(`window.__release && window.__release(); true`);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the form's async init resumes
        const after = await state();
        assert.equal(after[0], before[0], 'the label still says what was picked after the form finished loading: ' + JSON.stringify({ before, after }));
    } finally { await guard.restore(); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
