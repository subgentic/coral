// The agent list's group cards (group_cards.js, #8354: the module had no suite of its own): what a team's card, a workflow's and a folder's draw, the order the cards and the agents inside them go in,
// the actions each card's menu offers (their data-on-click names and the group they act on), and the two actions a person takes on the card itself: the header folds it and the kebab opens its menu.
// The list is drawn the way the dashboard draws it, from state.liveSessions (a team with an Orchestrator and one agent, a sleeping team, a workflow with a run and one without, two standalone folders), in team-first
// and in folder-first mode. 1280 px, isolated dev server; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const S = (id, name, extra) => ({ session_id: id, name, agent_type: 'claude', working_directory: '/tmp/proj', sleeping: false, ...extra });
// the sleeping team's agent is listed first: with no saved order the awake team must still come before it
const SESSIONS = [
    S('b-one', 'bee-1', { board_project: 'abacus', display_name: 'Sleeper', sleeping: true, working_directory: '/tmp/abacus' }),
    S('a-dev', 'dev-1', { board_project: 'alpha', display_name: 'Frontend Dev', working_directory: '/tmp/alpha' }),
    S('a-orc', 'orc-1', { board_project: 'alpha', display_name: 'Orchestrator', working_directory: '/tmp/alpha' }),
    S('w-1', 'wf-1', { workflow_name: 'Nightly', workflow_run_id: 7, display_name: 'Builder', working_directory: '/tmp/wf' }),
    S('w-2', 'wf-2', { workflow_name: 'Weekly', display_name: 'Reporter', working_directory: '/tmp/wf2' }),
    S('f-1', 'folder-a', { display_name: 'Solo One', working_directory: '/tmp/folder-a' }),
    S('f-2', 'folder-a', { display_name: 'Solo Two', working_directory: '/tmp/folder-a' }),
    S('f-3', 'folder-b', { display_name: 'Solo Three', working_directory: '/tmp/folder-b' }),
// a standalone agent's folder group is named by its session's name (sessionFolderKey), its directory is where the menu's actions start agents
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String(e.message).slice(0, 400)); } };
    // a card's header text, its menu's actions as "action:group-or-board:dir", and its agents' names in order
    const CARD = `(li => ({ cls: li.className, head: (li.querySelector('.group-name-line') || {}).textContent.replace(/\\s+/g, ' ').trim(), count: (li.querySelector('.session-group-count') || {}).textContent || null,
        actions: [...li.querySelectorAll(':scope > .board-card-header .sidebar-kebab-menu button[data-on-click]')].map(b => [b.dataset.onClick, b.dataset.board || b.dataset.group || b.dataset.runId || '', b.dataset.dir || b.dataset.mode || ''].filter(Boolean).join(':')),
        labels: [...li.querySelectorAll(':scope > .board-card-header .sidebar-kebab-menu button[data-on-click]')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
        agents: [...li.querySelectorAll('.board-card-agents > li .session-name, .board-card-agents > li [data-session-name]')].map(e => e.textContent.trim()) }))`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); localStorage.removeItem('coral-group-by-team'); window.switchNavTab('agents'); window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); return true; })()`);
        await waitFor(`document.querySelectorAll('.session-board-card').length >= 4`, 'the cards', 10000);

        await run('team first: the teams come first, an all-sleeping team after the active one, then the workflows, then the folders', async () => {
            const order = await ev(`[...document.querySelectorAll('li.session-board-card, li.session-group-header[data-group-name]')].filter(li => !li.closest('.board-card-agents')).map(li => li.dataset.groupName || li.querySelector('.board-card-header').dataset.groupName)`);
            assert.deepEqual(order, ['alpha', 'abacus', 'wf:Nightly', 'wf:Weekly', 'folder-a', 'folder-b'], JSON.stringify(order));
        });
        await run('a team card: its name, the team menu in its order, the Orchestrator first among its agents', async () => {
            const c = await ev(`(${CARD})(document.querySelector('li.session-team-group'))`);
            assert.equal(c.head.replace(/\s*\d+$/, ''), 'alpha', JSON.stringify(c));
            assert.deepEqual(c.actions.map(a => a.split(':')[0]), ['team-working-mode', 'team-add-agent', 'team-sleep', 'team-save', 'team-menu-more', 'team-availability', 'team-add-terminal', 'team-distill', 'team-share', 'team-accent', 'team-tokens', 'group-move', 'group-move', 'team-reset', 'team-kill', 'team-delete'], JSON.stringify(c.actions));
            assert.ok(c.actions.includes('team-add-agent:alpha:/tmp/alpha') && c.actions.includes('team-sleep:alpha:sleep') && c.actions.includes('group-move:alpha:up') && c.actions.includes('group-move:alpha:down'), 'each action names the team it acts on: ' + JSON.stringify(c.actions));
            assert.ok(c.labels.includes('Sleep Team') && !c.labels.includes('Wake Team'), 'an awake team offers Sleep Team: ' + c.labels);
            const names = await ev(`[...document.querySelector('li.session-team-group').querySelectorAll('.board-card-agents > li.session-group-item')].map(li => li.getAttribute('aria-label'))`);
            assert.deepEqual(names, ['Orchestrator, Idle', 'Frontend Dev, Idle'], 'the Orchestrator is the first row: ' + JSON.stringify(names));
            assert.equal(await ev(`(() => { const h = document.querySelector('li.session-team-group .board-card-header'); return [h.dataset.onClick, h.dataset.board, h.getAttribute('aria-label')].join('|'); })()`), 'team-name-open|alpha|Open team alpha', "the team's name opens the team");
        });
        await run('a sleeping team: wakes instead of sleeps, is marked sleeping, and says so on its header', async () => {
            const c = await ev(`(${CARD})(document.querySelectorAll('li.session-team-group')[1])`);
            assert.match(c.cls, /team-sleeping/); assert.ok(c.labels.includes('Wake Team') && c.actions.includes('team-sleep:abacus:wake'), JSON.stringify([c.labels, c.actions]));
            assert.equal(await ev(`!!document.querySelectorAll('li.session-team-group')[1].querySelector('.board-card-header .agent-icon[title="Team is sleeping"]')`), true, 'the moon on the header');
            assert.equal(await ev(`!!document.querySelectorAll('li.session-team-group')[0].querySelector('.board-card-header .agent-icon[title="Team is sleeping"]')`), false, 'and not on an awake team');
        });
        await run('a workflow card: its own look, View Run only when it has a run, Kill All for its group', async () => {
            const [a, b] = await ev(`[...document.querySelectorAll('li.session-wf-card')].map(li => (${CARD})(li))`);
            assert.ok(a.actions.includes('wf-run-open:7') && a.actions.includes('group-kill:wf:Nightly'), JSON.stringify(a.actions));
            assert.deepEqual(b.actions, ['group-kill:wf:Weekly'], 'a workflow with no run has no View Run: ' + JSON.stringify(b.actions));
            assert.ok(/Nightly/.test(a.head) && /Weekly/.test(b.head), JSON.stringify([a.head, b.head]));
        });
        await run('a folder group: a count of its agents, the folder menu, each action on its own folder and server', async () => {
            const heads = await ev(`[...document.querySelectorAll('li.session-group-header[data-group-name]')].filter(li => !li.closest('.board-card-agents')).map(li => ({ g: li.dataset.groupName, count: (li.querySelector('.session-group-count') || {}).textContent, actions: [...li.querySelectorAll('.sidebar-kebab-menu button[data-on-click]')].map(b => b.dataset.onClick + ':' + (b.dataset.dir && b.dataset.onClick !== 'group-move' ? b.dataset.dir : b.dataset.group || b.dataset.dir || '')), copy: (li.querySelector('.folder-copy-btn') || {}).dataset ? li.querySelector('.folder-copy-btn').dataset.dir : null }))`);
            const a = heads.find(h => h.g === 'folder-a'), b = heads.find(h => h.g === 'folder-b');
            assert.equal(a.count, '2'); assert.equal(b.count, '1');
            assert.deepEqual(a.actions.map(x => x.split(':')[0]), ['folder-launch-default', 'folder-add-agent', 'folder-add-terminal', ...a.actions.map(x => x.split(':')[0]).filter(x => /pin/.test(x)), 'folder-tag', 'group-move', 'group-move', 'group-kill'], JSON.stringify(a.actions));
            assert.ok(a.actions.includes('folder-launch-default:/tmp/folder-a') && a.actions.includes('group-kill:folder-a'), JSON.stringify(a.actions));
            assert.equal(a.copy, '/tmp/folder-a', 'Copy path copies the folder');
            assert.equal(await ev(`(document.querySelector('li.session-group-header[data-group-name="folder-a"] [data-on-click="folder-add-terminal"] .menu-item-hint') || {}).textContent || ''`), 'Opens a shell in this folder', 'the folder menu\'s Add Terminal has its one-line hint, as Add Agent has (#10164)');
        });
        await run('the header folds a card and a second click opens it again; the fold is kept', async () => {
            const hdr = `document.querySelector('li.session-team-group .group-chevron')`;
            assert.equal(await ev(`${hdr}.getAttribute('aria-expanded')`), 'true');
            await ev(`${hdr}.click(); true`); await waitFor(`document.querySelector('li.session-team-group .board-card-agents').classList.contains('board-card-collapsed')`, 'the team folded');
            assert.equal(await ev(`${hdr}.getAttribute('aria-expanded')`), 'false'); assert.equal(await ev(`${hdr}.getAttribute('aria-label')`), 'Expand alpha');
            assert.ok((await ev(`localStorage.getItem('coral_collapsed_groups')`)).includes('alpha'), 'the fold is remembered');
            await ev(`${hdr}.click(); true`); await waitFor(`!document.querySelector('li.session-team-group .board-card-agents').classList.contains('board-card-collapsed')`, 'the team open again');
            assert.equal(await ev(`${hdr}.getAttribute('aria-expanded')`), 'true');
            const f = `document.querySelector('li.session-group-header[data-group-name="folder-b"]')`;
            await ev(`${f}.click(); true`); await waitFor(`document.querySelector('li.session-group-header[data-group-name="folder-b"]').getAttribute('aria-expanded') === 'false'`, 'the folder folded');
            assert.equal(await ev(`document.querySelectorAll('li[data-session-id="f-3"]').length`), 0, "a folded folder draws none of its agents");
            await ev(`document.querySelector('li.session-group-header[data-group-name="folder-b"]').click(); true`); await waitFor(`document.querySelector('li.session-group-header[data-group-name="folder-b"]').getAttribute('aria-expanded') === 'true'`, 'the folder open again');
            assert.equal(await ev(`document.querySelectorAll('li[data-session-id="f-3"]').length`), 1, 'and an open one draws them');
        });
        await run('the kebab opens the team menu and names it for the team; it does not fold the card', async () => {
            const btn = `document.querySelector('li.session-team-group .group-kebab-btn')`;
            assert.equal(await ev(`${btn}.getAttribute('aria-expanded')`), 'false'); assert.match(await ev(`${btn}.getAttribute('aria-label')`), /More actions for alpha/);
            await ev(`${btn}.click(); true`); await waitFor(`${btn}.getAttribute('aria-expanded') === 'true'`, 'the menu open');
            assert.equal(await ev(`getComputedStyle(document.getElementById(${btn}.getAttribute('aria-controls'))).display !== 'none'`), true, 'the menu is shown');
            assert.equal(await ev(`document.querySelector('li.session-team-group .group-chevron').getAttribute('aria-expanded')`), 'true', 'the card stayed open');
            await ev(`document.body.click(); true`);
        });
        await run('the team menu shows the six a person uses and keeps the rest under More (#10549): Team settings, Add Agent, Sleep Team, Save as Template, Reset Team, Kill All (the danger group is last, after More, #10282), and Delete team (#10318); More opens the rest and the menu stays open', async () => {
            const btn = `document.querySelector('li.session-team-group .group-kebab-btn')`;
            await ev(`${btn}.click(); true`); await waitFor(`${btn}.getAttribute('aria-expanded') === 'true'`, 'the menu open');
            const shown = () => ev(`[...document.getElementById(${btn}.getAttribute('aria-controls')).querySelectorAll('.overflow-menu-item')].filter(b => b.getClientRects().length).map(b => { const c = b.cloneNode(true); c.querySelectorAll('.material-icons, svg').forEach(i => i.remove()); return c.textContent.replace(/\\s+/g, ' ').trim(); })`);
            const six = ['Team settings', 'Add Agent', 'Sleep Team', 'Save as Template', 'More', 'Reset Team', 'Kill All', 'Delete team']; // the six, More, then the danger group last (#10282) with Delete team (#10318)
            assert.deepEqual(await shown(), six, 'six and More: ' + JSON.stringify(await shown()));
            const more = `document.querySelector('li.session-team-group [data-on-click="team-menu-more"]')`;
            assert.equal(await ev(`${more}.getAttribute('aria-expanded')`), 'false', 'More starts closed');
            await ev(`${more}.click(); true`);
            assert.equal(await ev(`${more}.getAttribute('aria-expanded')`), 'true', 'More says it is open');
            assert.equal(await ev(`${btn}.getAttribute('aria-expanded')`), 'true', 'the menu stays open');
            const after = await shown();
            for (const w of ['Team view', 'Add Terminal', 'Distill Knowledge', 'Share Team', 'Set Color', 'Token Usage', 'Move Up', 'Move Down']) assert.ok(after.some(x => x.startsWith(w)), `${w} is under More: ` + JSON.stringify(after));
            await ev(`${more}.click(); true`);
            assert.deepEqual(await shown(), six, 'More closes again');
            await ev(`document.body.click(); true`);
        });
        await run('folder first: every folder is a group and the boards are cards inside them; no workflow cards', async () => {
            await ev(`localStorage.setItem('coral-group-by-team', 'false'); window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); true`);
            await waitFor(`!!document.querySelector('li.session-group-header[data-group-name="folder-a"] .session-group-count') && !document.querySelector('li.session-group-header[data-group-name="/tmp/none"]')`, 'folder first');
            const heads = await ev(`[...document.querySelectorAll('li.session-group-header[data-group-name]')].map(li => li.dataset.groupName)`);
            for (const g of ['folder-a', 'folder-b', 'dev-1', 'bee-1']) assert.ok(heads.includes(g), `${g} is a folder: ${JSON.stringify(heads)}`);
            assert.equal(await ev(`document.querySelectorAll('li.session-wf-card').length`), 0, 'no workflow cards in folder-first mode');
            assert.ok(await ev(`document.querySelectorAll('li.session-board-card').length`) >= 2, 'the boards are cards');
            assert.equal(await ev(`document.querySelectorAll('li.session-group-header[data-group-name="folder-a"] ~ li.session-group-item').length >= 2`), true, 'the folder holds its two agents');
            assert.equal(await ev(`document.querySelector('li.session-group-header[data-group-name="folder-a"] .session-group-count').textContent`), '2');
        });
    } finally { await client.close(); }
    const failed = results.filter(([, e]) => e);
    if (failed.length) { console.log(`\n${failed.length} of ${results.length} FAILED`); process.exit(1); }
    console.log(`PASS group_cards: ${results.length} checks`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
