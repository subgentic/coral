// Skills in New agent and New team (#12104, goal #191): the approved skills are listed in both dialogs (a skill with scripts says so), ticking some adds `skills` (ids) to the launch request and ticking none
// leaves the request as it was, the team's row is for every member, another computer's launch has no row, and a team member's own dialog has none. The routes are stood in. 1440 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

const SKILLS = [
    { id: '1'.repeat(32), name: 'release-notes', version: 3, description: 'Writes release notes.', status: 'approved', has_scripts: false, not_reviewable: false },
    { id: '2'.repeat(32), name: 'db-review', version: 1, description: 'Checks a SQL migration.', status: 'approved', has_scripts: true, not_reviewable: false },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            window.__reqs = [];
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                if (p.pathname === '/api/skills' && p.searchParams.get('status') === 'approved') return json({ skills: ${JSON.stringify(SKILLS)} });
                if (m === 'POST' && /^\\/api\\/sessions\\/(launch|launch-team)$/.test(p.pathname)) {
                    window.__reqs.push({ path: p.pathname, body: JSON.parse(o.body) });
                    return p.pathname === '/api/sessions/launch-team' ? json({ agents: [{ name: 'A', session_id: 's' }] }) : json({ session_name: 'launched-1', session_id: 'sid-1' });
                }
                if (p.pathname === '/api/board/projects') return json([{ project: 'taken' }]);
                if (p.pathname === '/api/filesystem/is-git') return json({ is_git: true });
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal();
            return true; })()`);
        const take = async (n0, what) => { await waitFor(`window.__reqs.length > ${n0}`, what, 8000); return ev(`window.__reqs[${n0}]`); };
        const fill = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const click = sel => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.getClientRects().length) || document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click(); return true; })()`);
        const tick = (host, id) => ev(`(() => { const b = document.querySelector('#${host} input[type=checkbox][value="${id}"]'); b.click(); return b.checked; })()`);
        const rowsOf = host => ev(`Array.from(document.querySelectorAll('#${host} .skills-pick')).map(li => li.textContent.replace(/\\s+/g, ' ').trim())`);

        // New agent: listed, one ticked
        await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none' && !!document.querySelector('#launch-agent-acf .acf-agent-type') && !document.getElementById('launch-skills-row').hidden`, 'the agent step with its skills row', 8000);
        const listed = await rowsOf('launch-skills-host');
        assert.equal(listed.length, 2);
        assert.match(listed[0], /release-notes v3.*Writes release notes\./);
        assert.match(listed[1], /db-review v1.*includes scripts/, 'a skill with scripts says so');
        await fill('launch-dir', '/work/repo');
        await click('#launch-step-agent [data-on-click="m-launch-session"]');
        let sent = await take(0, 'the launch with nothing ticked');
        assert.equal('skills' in sent.body, false, 'nothing ticked: the request is what it was');
        await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none' && !document.getElementById('launch-skills-row').hidden && document.querySelectorAll('#launch-skills-host .skills-pick').length === 2`, 'the row again', 8000);
        assert.equal(await tick('launch-skills-host', SKILLS[1].id), true);
        await fill('launch-dir', '/work/repo');
        await click('#launch-step-agent [data-on-click="m-launch-session"]');
        sent = await take(1, 'the launch with a skill ticked');
        assert.deepEqual(sent.body.skills, [SKILLS[1].id], 'the ticked skill is sent by its id');

        // New team: the team's row, both ticked
        await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && !document.getElementById('team-skills-row').hidden`, 'the team step with its skills row', 8000);
        assert.match(await ev(`document.getElementById('team-skills-label').textContent`), /Skills for every member/);
        await ev(`document.getElementById('team-agents-list').innerHTML = ''; true`);
        await fill('team-board-name', 'alpha-team'); await fill('launch-team-dir', '/work/repo');
        await fill('team-agent-type', 'codex'); await fill('team-permission-mode', 'plan'); await fill('team-board-server', 'http://remote:8420'); // as the other dialog suite sets them (a remote board: the launch does not wait on this computer's tmux)
        await ev(`window.showTeamAgentModal(); true`);
        await waitFor(`document.getElementById('launch-modal').hasAttribute('data-member') && getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none' && !!document.getElementById('launch-agent-name-input')`, 'the member dialog', 8000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('launch-skills-row')).display`), 'none', 'a team member\'s own dialog has no skills row');
        await fill('launch-agent-name-input', 'Orchestrator');
        await ev(`(() => { const e = document.querySelector('#launch-agent-acf .acf-prompt'); e.value = 'Write the code.'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await click('#launch-step-agent #launch-agent-save');
        await waitFor(`!document.getElementById('launch-modal').hasAttribute('data-member')`, 'the member dialog to close', 8000);
        await tick('team-skills-host', SKILLS[0].id); await tick('team-skills-host', SKILLS[1].id);
        await click('#launch-step-team [data-on-click="m-launch-team"]');
        const why = () => ev(`[...document.querySelectorAll('.toast, [role=alert], .field-error, .launch-recap-error, #team-step-live')].map(e => e.textContent.trim()).filter(Boolean).join(' | ')`);
        sent = await take(2, 'the team launch').catch(async e => { throw new Error(e.message + ' :: ' + await why()); });
        assert.deepEqual(sent.body.skills, [SKILLS[0].id, SKILLS[1].id], 'the team request carries the skills for every member');

        // another computer's launch has no row, and nothing is sent from it
        await ev(`import((window.__coralStatic || '/static/') + 'launch_skills.js').then(m => m.mountLaunchSkills('launch-skills', false))`);
        assert.equal(await ev(`document.getElementById('launch-skills-row').hidden`), true);
        assert.deepEqual(await ev(`import((window.__coralStatic || '/static/') + 'launch_skills.js').then(m => m.launchSkillIds('launch-skills'))`), []);
        console.log('PASS Skills in New agent and New team');
    } finally { await removeBoards(ev, ['alpha-team']); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
