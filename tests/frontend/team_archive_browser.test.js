// Archive team and Restore team (#17491, walk 71 H3; the server's team archive, #21850): a team can be put away and brought back as one. Before this, Archive was per agent: archiving a team's three agents made the team vanish from the sidebar,
// leaving a nameless 'Archived (3)', and bringing it back was Unarchive three times. Here, on the harness's stand-in agents: the sidebar team menu offers Archive team, asks once, and archives every member; the
// Archived line names the team; the team's caption has Restore team, which brings every agent back asleep (nothing is woken) and the team returns to the list; the team page's menu says Restore team while archived.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install, select } = await connect();
    const rows = () => ev(`T.state.liveSessions.filter(s => s.board_project === 'recipe').map(s => ({ n: s.name, a: !!s.archived, z: !!s.sleeping }))`);
    const confirmYes = async () => { await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question'); await ev(`[...document.querySelectorAll('#confirm-modal button')].find(b => /archive team/i.test(b.textContent)).click(); true`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat'); localStorage.setItem('coral-archived-expanded', 'true'); true`);
        await ev(`(() => { const m = window.__m;
            m.add('r-orch', 'O', 60, { sleeping: false, board_project: 'recipe' }); m.add('r-dev', 'D', 60, { sleeping: false, board_project: 'recipe' }); m.add('r-qa', 'Q', 60, { sleeping: false, board_project: 'recipe' });
            m.add('other-1', 'X', 60, { sleeping: false, board_project: 'other' });
            T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        // the server archives only a team it knows (a board with a post; an unknown name is a 404, #21915): the stand-in team has a board here
        assert.equal(await ev(`fetch('/api/board/recipe/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'r-orch', content: 'kickoff', as: 'O' }) }).then(r => r.status)`), 200, 'the stand-in team has a board');
        // 1. the team's sidebar menu offers Archive team, and says what it does before it does it
        const labels = await ev(`(() => { const g = [...document.querySelectorAll('li.session-team-group')].find(l => /recipe/i.test(l.textContent)); return [...g.querySelectorAll('.group-kebab .overflow-menu-item')].map(b => b.textContent.replace(/\s+/g, ' ').trim()); })()`);
        assert.ok(labels.includes('Archive team'), 'the sidebar team menu offers Archive team: ' + JSON.stringify(labels));
        assert.ok(await ev(`!!([...document.querySelectorAll('li.session-team-group')].find(l => /recipe/i.test(l.textContent)).querySelector('[data-mode="archive"] svg'))`), 'the Archive team item has an icon, as its neighbours do (#17647)');
        await select('r-dev'); // a chat of the team is open while it is archived
        assert.ok(!(await ev(`document.getElementById('command-pane').classList.contains('agent-sleeping')`)), 'the open chat is awake before');
        await ev(`[...document.querySelectorAll('li.session-team-group')].find(l => /recipe/i.test(l.textContent)).querySelector('[data-mode="archive"]').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question');
        const ask = await ev(`document.getElementById('confirm-modal-message').textContent`);
        assert.ok(/Stops: its 3 agents/.test(ask) && /Stays: everything/.test(ask) && /Restore team/.test(ask), 'it says what stops, what stays and the way back: ' + ask);
        await ev(`[...document.querySelectorAll('#confirm-modal button')].find(b => /archive team/i.test(b.textContent)).click(); true`);
        await waitFor(`T.state.liveSessions.filter(s => s.board_project === 'recipe').every(s => s.archived)`, 'every member archived', 8000);
        await waitFor(`document.getElementById('command-pane').classList.contains('agent-sleeping')`, 'the open chat shows its agent asleep at once, as Archive agent does, not on the next feed tick (#17647)', 1000);
        // 2. an archived team is nowhere in the sidebar: no team row, no agent rows, no Archived line (#21850: Restore team is on the Teams page)
        const after = await ev(`({ summary: !!document.querySelector('.archived-summary-row'), caption: !!document.querySelector('.archived-team-caption'), groups: [...document.querySelectorAll('li.session-team-group')].map(l => l.textContent.trim().slice(0, 30)), rows: document.querySelectorAll('#live-sessions-list .session-group-item[data-session-id]').length })`);
        assert.ok(!after.summary && !after.caption, 'no Archived line or team caption for it in the sidebar: ' + JSON.stringify(after));
        assert.ok(!after.groups.some(g => /recipe/i.test(g)), 'the team is out of the list: ' + JSON.stringify(after));
        assert.ok(await ev(`T.state.liveSessions.filter(s => s.board_project === 'recipe').every(s => s.team_archived && s.sleeping)`), 'its agents are archived with the team, asleep');
        // 3. Restore team (the Teams page has the button; its action is this one): every agent is back, asleep, nothing woken; the team returns
        await ev(`window.toggleTeamSleep('recipe', 'restore'); true`);
        await waitFor(`T.state.liveSessions.filter(s => s.board_project === 'recipe').every(s => !s.archived)`, 'every member restored', 8000);
        const back = await rows();
        assert.ok(back.length === 3 && back.every(r => !r.a && r.z), 'all three are back, asleep (nothing woken): ' + JSON.stringify(back));
        const list = await ev(`({ archivedLine: !!document.querySelector('.archived-summary-row'), groups: [...document.querySelectorAll('li.session-team-group')].map(l => l.textContent.trim().slice(0, 30)) })`);
        assert.ok(!list.archivedLine && list.groups.some(g => /recipe/i.test(g)), 'the Archived line is gone and the team is back in the list: ' + JSON.stringify(list));
        console.log('PASS team_archive_browser: Archive team leaves the sidebar entirely, Restore team brings it back');
    } finally { await ev(`fetch('/api/board/recipe', { method: 'DELETE' }).then(() => true)`).catch(() => {}); await client.close(); } // the stand-in team's board is removed: a suite leaves no row in the shared server
})().catch(e => { console.error(e); process.exit(1); });
