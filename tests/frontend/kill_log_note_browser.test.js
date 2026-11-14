// #4399 (from Security's #4371 table): every Kill confirmation says what happens to the agent's terminal log, that it is kept and where (#4437: Kill
// keeps it on both backends): Kill session (the agent header and the sidebar row), Kill all Agents (a folder group), Kill Team and Reset team (which
// kills and restarts its agents). Cancel sends no kill. The code fact: neither tmux Client.KillSession nor the pty backend's kill removes the log.
// KILL_NOTE_SHOT=<dir> saves a screenshot of each confirmation. Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;
const NOTE = "Its terminal log is kept, in the logs folder of Coral's data folder.";
const NOTE_MANY = "Their terminal logs are kept, in the logs folder of Coral's data folder.";
const NOTE_RESET = 'Their terminal logs are kept.'; // Reset says it in plain words: where the folder is is for Settings (#10549)

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install, reqs, clearReqs } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat');
            T.state.liveSessions = []; window.__m.agents = {};
            window.__m.add('repo', 'K', 3, { sleeping: false, session_id: 's1' });
            window.__m.add('repo', 'K', 3, { sleeping: false, session_id: 's2' });
            window.__m.add('team-agent', 'K', 3, { sleeping: false, session_id: 't1', board_project: 'team-k' });
            window.__m.add('zz-sleep', 'K', 3, { sleeping: true, session_id: 's3' });
            window.__m.add('zz-arch', 'K', 3, { sleeping: true, archived: true, session_id: 's4' });
            T.render.renderLiveSessions(T.state.liveSessions); true`);
        const open = `getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`;
        const asked = async (label, start, title, note = NOTE, says = '') => {
            await clearReqs();
            await ev(`(async () => { ${start}; return true; })()`);
            await waitFor(open, `the ${label} confirmation`, 8000);
            const d = await ev(`({ title: document.getElementById('confirm-modal-title').textContent, message: document.getElementById('confirm-modal-message').textContent })`);
            if (process.env.KILL_NOTE_SHOT) require('node:fs').writeFileSync(`${process.env.KILL_NOTE_SHOT}/${title.replace(/ /g, '-').toLowerCase()}-${label.includes('header') ? 'header' : 'x'}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            assert.equal(d.title, title, `${label}: title`);
            assert.ok(d.message.endsWith(note), `${label}: the message ends with the log note: ${d.message}`);
            assert.equal(d.message.split(note).length, 2, `${label}: the note is said once`);
            assert.ok(!d.message.includes('agent(s)'), `${label}: a count, not agent(s): ${d.message}`);
            if (says) assert.ok(d.message.includes(says), `${label}: says ${says}: ${d.message}`);
            await ev(`document.querySelector('#confirm-modal .btn:not(#confirm-modal-yes)').click(); true`);
            await waitFor(`!(${open})`, `the ${label} confirmation to close`, 4000);
            assert.equal((await reqs()).filter(r => r.kind === 'kill').length, 0, `${label}: Cancel sends no kill`);
            console.log(`   ✓ ${label}: ${d.message}`);
        };
        console.log('Every Kill confirmation says what happens to the terminal log');
        await asked('Kill session (sidebar row)', `T.render.killSessionDirect('repo', 'claude', 's1')`, 'Stop session');
        // a sleeping or archived row's menu says Remove Agent, so its confirmation does (#15585): nothing runs, so it does not say it terminates anything
        await asked('Remove Agent (sleeping row)', `T.render.killSessionDirect('zz-sleep', 'claude', 's3')`, 'Remove agent', NOTE, ' is not running.');
        await asked('Remove Agent (archived row)', `T.render.killSessionDirect('zz-arch', 'claude', 's4')`, 'Remove agent', NOTE, ' is not running.');
        await asked('Kill session (agent header)', `T.state.currentSession = { type: 'live', name: 'repo', session_id: 's1', agent_type: 'claude' }; (await import((window.__coralStatic || '/static/') + 'controls.js')).killSession()`, 'Stop session');
        await asked('Kill all Agents (folder)', `T.render.killGroup('repo')`, 'Stop all agents', NOTE_MANY, 'Stop all 2 agents in');
        await asked('Kill Team (one agent)', `T.render.killBoard('team-k')`, 'Stop team', NOTE, 'Stop the 1 agent in "team-k"');
        await asked('Reset team', `window.resetTeam('team-k')`, 'Reset team', NOTE_RESET);
        assert.ok(!(await ev(`document.getElementById('confirm-modal-message').textContent`)).includes('logs folder'), 'Reset does not name the logs folder of the data folder');
        // Sleep team says what Reset says: the chats stay (#10549, the Desktop tester)
        await ev(`window.toggleTeamSleep('team-k', 'sleep'); true`);
        await waitFor(open, 'the Sleep team confirmation', 8000);
        const sleepWords = await ev(`document.getElementById('confirm-modal-message').textContent`);
        assert.ok(/chats stay/i.test(sleepWords) && /Wake team/.test(sleepWords), 'Sleep team says the chats stay and that Wake team starts them again: ' + sleepWords);
        await ev(`document.querySelector('#confirm-modal .btn:not(#confirm-modal-yes)').click(); true`);
        console.log('PASS');
    } catch (e) {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    } finally {
        try { await client.close(); } catch (_) {}
    }
})();
