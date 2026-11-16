// Skills in Edit member (#18657, the Operator: "can't add skills to individual agents"): the member's dialog has a Skills section with the same pick list as New agent and New team; what is
// ticked is saved on the member and sent as that member's own `skills` in the team launch; the team's skills show in it ticked and fixed as "from the team" and are not the member's own;
// a member with no skills of its own sends no `skills`; reopening the member shows what it has. The routes are stood in. 1440 px and 390 px, isolated dev server (not the live Coral).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

const SKILLS = [
    { id: '1'.repeat(32), name: 'release-notes', version: 3, description: 'Writes release notes.', status: 'approved', has_scripts: false, not_reviewable: false },
    { id: '2'.repeat(32), name: 'db-review', version: 1, description: 'Checks a SQL migration.', status: 'approved', has_scripts: true, not_reviewable: false },
    { id: '3'.repeat(32), name: 'style-guide', version: 2, description: 'The house style.', status: 'approved', has_scripts: false, not_reviewable: false },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name.replace(/[^a-z0-9-]+/gi, '-') + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, width, height] of [['1440', 1440, 900], ['390', 390, 844]]) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: width < 600 });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(async () => {
                window.__reqs = [];
                const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                    if (p.pathname === '/api/skills' && p.searchParams.get('status') === 'approved') return json({ skills: ${JSON.stringify(SKILLS)} });
                    if (m === 'POST' && p.pathname === '/api/sessions/launch-team') { window.__reqs.push({ path: p.pathname, body: JSON.parse(o.body) }); return json({ agents: [{ name: 'A', session_id: 's' }] }); }
                    if (p.pathname === '/api/board/projects') return json([{ project: 'taken' }]);
                    if (p.pathname === '/api/filesystem/is-git') return json({ is_git: true });
                    return real(u, o); };
                await window.showLaunchModal(); window.hideLaunchModal();
                return true; })()`);
            const fill = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            const click = sel => ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.getClientRects().length) || document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
            const tick = (host, id) => ev(`(() => { const b = document.querySelector('#${host} input[type=checkbox][value="${id}"]'); b.click(); return b.checked; })()`);
            const boxes = () => ev(`Object.fromEntries(Array.from(document.querySelectorAll('#launch-skills-host input[type=checkbox]')).map(b => [b.value, { checked: b.checked, disabled: b.disabled }]))`);
            const openMember = async (open, what) => {
                await ev(`${open}; true`);
                await waitFor(`document.getElementById('launch-modal').hasAttribute('data-member') && getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none' && !!document.getElementById('launch-agent-name-input')`, what, 8000);
                await waitFor(`document.querySelectorAll('#launch-skills-host .skills-pick').length === ${SKILLS.length}`, 'the skills listed in the member dialog', 8000);
            };
            const toSkills = async () => { await ev(`(() => { const t = document.querySelector('#launch-agent-acf').closest('.settings-shell')?.querySelector('[role=tab][aria-controls$="-pane-skills"]') || document.querySelector('[role=tab][aria-controls$="-pane-skills"]'); if (t) t.click(); else { const s = document.querySelector('.settings-group-pick select'); if (s) { s.value = 'skills'; s.dispatchEvent(new Event('change', { bubbles: true })); } } return true; })()`); await waitFor(`!document.querySelector('#launch-agent-acf [data-section="skills"]').hidden`, 'the Skills section open', 4000); };
            const saveMember = async () => { await click('#launch-step-agent #launch-agent-save'); await waitFor(`!document.getElementById('launch-modal').hasAttribute('data-member')`, 'the member dialog to close', 8000); };

            // New team with the team's skill ticked
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && !document.getElementById('team-skills-row').hidden && document.querySelectorAll('#team-skills-host .skills-pick').length === ${SKILLS.length}`, 'the team step with its skills row', 8000);
            await ev(`document.getElementById('team-agents-list').innerHTML = ''; true`);
            await fill('team-board-name', 'skills-team'); await fill('launch-team-dir', '/work/repo');
            await fill('team-agent-type', 'codex'); await fill('team-permission-mode', 'plan'); await fill('team-board-server', 'http://remote:8420');
            await ev(`document.querySelector('#team-skills-host .skills-pick-more').open = true; true`);
            await tick('team-skills-host', SKILLS[0].id);

            // Add member: the Skills section is there, the team's skill is shown from the team, one of its own is ticked
            await openMember(`window.showTeamAgentModal()`, 'the Add member dialog');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#launch-agent-acf [data-section]')].map(p => p.dataset.title)`), ['Agent', 'Permissions', 'Skills', 'Advanced'], 'Edit member has an Agent, Permissions, Skills and Advanced section');
            await fill('launch-agent-name-input', 'Orchestrator');
            await ev(`(() => { const e = document.querySelector('#launch-agent-acf .acf-prompt'); e.value = 'Write the code.'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await toSkills();
            let state = await boxes();
            assert.deepEqual(state[SKILLS[0].id], { checked: true, disabled: true }, 'the team\'s skill is ticked and fixed');
            assert.match(await ev(`document.querySelector('#launch-skills-host .skills-pick .skills-from-team').textContent`), /from the team/);
            assert.deepEqual(state[SKILLS[1].id], { checked: false, disabled: false });
            await ev(`document.querySelector('#launch-skills-host .skills-pick-more').open = true; true`);
            assert.equal(await tick('launch-skills-host', SKILLS[1].id), true, 'a skill of the member\'s own ticks');
            await shot(`member-skills-${label}`);
            await saveMember();

            // A second member with nothing of its own
            await openMember(`window.showTeamAgentModal(null, { role: 'Reviewer' })`, 'the second member dialog');
            await ev(`(() => { const e = document.querySelector('#launch-agent-acf .acf-prompt'); e.value = 'Review the code.'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await saveMember();

            // Edit member: reopening shows what it has; the team's is still marked as the team's
            await openMember(`window.showTeamAgentModal(document.querySelector('#team-agents-list .team-agent-row'))`, 'the Edit member dialog');
            await toSkills();
            state = await boxes();
            assert.deepEqual(state[SKILLS[1].id], { checked: true, disabled: false }, 'Edit member shows the member\'s own skill ticked');
            assert.deepEqual(state[SKILLS[0].id], { checked: true, disabled: true }, 'and the team\'s as the team\'s');
            assert.match(await ev(`document.querySelector('#launch-skills-host .skills-pick-summary').textContent`), /1 chosen, 1 from the team/);
            // Unticking and saving takes the member's skill off again, and the row carries none; ticking it again puts it back
            assert.equal(await tick('launch-skills-host', SKILLS[1].id), false, 'unticked');
            await saveMember();
            assert.equal(await ev(`document.querySelector('#team-agents-list .team-agent-row').dataset.skills === undefined`), true, 'the member keeps no skills');
            await openMember(`window.showTeamAgentModal(document.querySelector('#team-agents-list .team-agent-row'))`, 'the Edit member dialog again');
            await toSkills();
            assert.equal(await tick('launch-skills-host', SKILLS[1].id), true, 'ticked again');
            await saveMember();
            await openMember(`window.showTeamAgentModal(document.querySelector('#team-agents-list .team-agent-row'))`, 'Edit member to cancel');
            await ev(`window.cancelTeamMember(); true`);
            await waitFor(`!document.getElementById('launch-modal').hasAttribute('data-member')`, 'the dialog closed without saving', 8000);

            // The launch: the team's skills for every member, the member's own on that member only; the other member sends none
            await click('#launch-step-team [data-on-click="m-launch-team"]');
            await waitFor(`window.__reqs.length > 0`, 'the team launch', 8000);
            const sent = await ev(`window.__reqs[0]`);
            assert.deepEqual(sent.body.skills, [SKILLS[0].id], 'the team request carries the team\'s skills');
            const [orch, rev] = sent.body.agents;
            assert.deepEqual(orch.skills, [SKILLS[1].id], 'the first member carries its own skill');
            assert.equal('skills' in rev, false, 'a member with none sends no skills field: its request is what it was');

            await removeBoards(ev, ['skills-team']);
            console.log(`PASS Edit member Skills at ${label}`);
        }
    } finally { await removeBoards(ev, ['skills-team']); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
