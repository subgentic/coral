// First-run audit: a brand-new agent's empty chat says what it is waiting for and what to do next, by the agent's state.
//  - idle: a title and a hint ("Type below to start."); a role=status block, sized in rem
//  - not started: the "Waiting in the terminal" card already says it, so no empty state shows under it (nothing to add)
//  - asleep: it says so and points at waking it
//  - archived: it says archived and nothing about sleep or Wake (#10784)
//  - the words are written once: a later refresh does not rewrite them (a screen reader is not told again)
//  - the first message replaces it
// Drives Chrome over CDP through agent_view_harness.js; run_cdp_suites.mjs finds CDP suites by that name.
// EMPTY_CHAT_SHOT=<dir> also writes a screenshot of each case there (not needed to pass).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        const shot = async (name) => {
            const dir = process.env.EMPTY_CHAT_SHOT;
            if (!dir) return;
            const { data } = await Page.captureScreenshot({ format: 'png' });
            fs.writeFileSync(`${dir}/${name}.png`, Buffer.from(data, 'base64'));
        };
        const words = () => ev(`(() => { const e = document.querySelector('#live-history-messages > .chat-empty'); return e ? { role: e.getAttribute('role'), title: (e.querySelector('.chat-empty-title') || {}).textContent || '', hint: (e.querySelector('.chat-empty-hint') || {}).textContent || '', size: getComputedStyle(e).fontSize } : null; })()`);
        const open = async (name, patch) => {
            await ev(`window.__m.add('${name}', '${name}', 0, { sleeping: ${patch.sleeping ? 'true' : 'false'}, archived: ${patch.archived ? 'true' : 'false'} }); { const r = window.T.state.liveSessions.find(x => x.session_id === '${name}-id'); if (r) r.staleness_seconds = ${patch.fresh || patch.old ? 'null' : '5'}; ${patch.age !== undefined ? 'r.created_at = new Date(Date.now() - ' + patch.age + ' * 1000).toISOString();' : ''} } true`); // the CLI has written output (5 s ago) unless this one is a just-launched agent with none (#6058)
            await ev(`{ const r = window.T.state.liveSessions.find(x => x.session_id === '${name}-id'); if (r) { r.working_directory = '/home/u/work-dir'; ${patch.mode ? `r.permission_mode = '${patch.mode}';` : ''} ${patch.live ? `r.live_permission_mode = '${patch.live}';` : ''} ${patch.type ? `r.agent_type = '${patch.type}';` : ''} } } true`);
            await ev(`window.selectLiveSession('${name}', '${patch.type || 'claude'}', '${name}-id', 'local'); true`);
            await waitFor(`!!document.querySelector('#live-history-messages > .chat-empty')`, `the empty state of ${name}`, 8000);
        };

        console.log('1. An idle new agent: a title, and what to do next');
        await open('ec-idle', {});
        const said = () => waitFor(`/mode:|Pi has no/.test((document.querySelector('#live-history-messages > .chat-empty .chat-empty-hint') || {}).textContent || '')`, 'the words of how the agent acts (the settings words load on first use)', 6000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the settings words load on first use; with no mode on record there is nothing to wait for, so the line is read after they could have
        let w = await words();
        assert.equal(w.role, 'status');
        assert.equal(w.title, 'Say hello to your agent');
        assert.match(w.hint, /Type below to start\.$/); // #5991: the keys and what appears are said by the box itself
        assert.equal(w.size, '14px', 'sized in rem: 0.875rem is 14px at the default size');
        // #10035 (the desktop tester: no hint what this agent can touch): the empty chat says where the agent works and how it acts, in plain words; no mode on record is the default, Auto
        assert.equal(w.hint, 'Working in work-dir. Type below to start.', 'no mode on record: the folder, and nothing about how it acts (a guess of Auto was wrong for a Default launch, #10253): ' + JSON.stringify(w.hint));
        await shot('idle');
        console.log('1a. How it acts, by the mode it was launched with');
        for (const [mode, type, expected] of [['auto', 'claude', 'Auto mode: everything, with safety checks.'], ['default', 'claude', 'Default mode: asks before acting (each CLI\'s normal mode).'], ['acceptEdits', 'claude', 'Accept edits mode: reads, file edits, and common filesystem commands (mkdir, touch, mv, cp, etc.) — best for iterating on code you\'re reviewing.'], ['plan', 'claude', 'Plan mode: reads only — best for exploring a codebase before changing it.'], ['auto', 'codex', 'Auto mode: workspace sandbox, with the network on so it can reach Coral.'], ['auto', 'agy', 'Auto mode: everything, with no prompts and no safety checks.'], ['auto', 'pi', 'Pi has no permission prompts: it always acts on its own.']]) {
            const name = `ec-mode-${mode}-${type}`;
            await open(name, { mode, type }); await said();
            w = await words();
            assert.equal(w.hint, `Working in work-dir. ${expected} Type below to start.`, `${mode}: ` + JSON.stringify(w.hint));
        }
        // the CLI's own report (live_permission_mode, Claude's hook) follows Shift+Tab: it wins over the launch's stored mode, and stands alone when none is stored
        for (const [mode, live, expected] of [['auto', 'plan', 'Plan mode: reads only — best for exploring a codebase before changing it.'], [undefined, 'default', 'Default mode: asks before acting (each CLI\'s normal mode).']]) {
            await open(`ec-live-${live}-${mode || 'none'}`, { mode, live }); await said();
            w = await words();
            assert.equal(w.hint, `Working in work-dir. ${expected} Type below to start.`, `reported ${live}, stored ${mode}: ` + JSON.stringify(w.hint));
        }
        await open('ec-idle', {});

        console.log('1b. The first seconds of a new agent: its CLI has written nothing yet, so it says it is coming up (#6058)');
        await open('ec-fresh', { fresh: true, age: 3 });
        w = await words();
        assert.equal(w.title, 'Waiting for Claude to start');
        assert.match(w.hint, /first screen is not up yet/);
        await shot('starting');

        console.log('1c. An agent started hours ago with no output on record is not "starting": the 25 s counts from its own start (created_at), not from this page opening it');
        await open('ec-old', { old: true, age: 7200 });
        w = await words();
        assert.equal(w.title, 'Say hello to your agent', 'an old live agent with no output age: ' + JSON.stringify(w));
        assert.match(w.hint, /Type below to start\.$/);

        console.log('2. The words are written once, not at every refresh');
        await ev(`window.__ecMuts = 0; new MutationObserver(m => { window.__ecMuts += m.length; }).observe(document.querySelector('#live-history-messages > .chat-empty'), { childList: true, characterData: true, subtree: true }); true`);
        await ev(`window.refreshLiveHistory ? window.refreshLiveHistory() : null; true`);
        await new Promise(r => setTimeout(r, 2500)); // sleep-ok: two poll rounds with nothing to change; the check is that nothing is rewritten
        assert.equal(await ev(`window.__ecMuts`), 0, 'a refresh with the same state rewrites nothing');

        console.log('3. A sleeping agent says so');
        await open('ec-sleep', { sleeping: true });
        await waitFor(`(document.querySelector('#live-history-messages > .chat-empty .chat-empty-title') || {}).textContent === 'This agent is asleep'`, 'the asleep words', 8000);
        assert.match((await words()).hint, /Wake below/);
        await shot('asleep');

        console.log('3b. An archived agent says archived only: not asleep, and no Wake to use (#10784)');
        await open('ec-arch', { archived: true });
        await waitFor(`(document.querySelector('#live-history-messages > .chat-empty .chat-empty-title') || {}).textContent === 'This agent is archived'`, 'the archived words', 8000);
        const arch = await words();
        assert.doesNotMatch(arch.title + ' ' + arch.hint, /asleep|sleeping|Wake/i, 'nothing about sleeping or waking: ' + JSON.stringify(arch));

        console.log('4. At 200% text the words grow with the root size');
        await ev(`document.documentElement.style.fontSize = '32px'; true`);
        assert.equal((await words()).size, '28px');
        await ev(`document.documentElement.style.fontSize = ''; true`);

        console.log('5. The first message replaces the empty state');
        await ev(`window.__m.agents['ec-idle-id'].msgs.push({ type: 'user', content: 'hello' }); true`);
        await ev(`window.selectLiveSession('ec-idle', 'claude', 'ec-idle-id', 'local'); true`);
        await waitFor(`!document.querySelector('#live-history-messages > .chat-empty') && document.querySelectorAll('#live-history-messages .chat-bubble, #live-history-messages [class*=bubble]').length > 0`, 'the message in place of the empty state', 8000);
        console.log('PASS');
    } catch (e) {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    } finally {
        try { await client.close(); } catch (_) {}
    }
})();
