// An agent is one line in the sidebar (#9686, UI/UX's #9358, Goal #79 item 26): the state dot, the name (13/500) and at most one chip, 36 px a row on a desktop and 44 px on a phone. The goal, the provider and
// model, the branch and the held-message lines are not on the row (the hover tip and the agent's page have them); the one chip is "Needs input" for an agent that asks, else "Message held" for an agent whose
// paste was held, else none. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const base = o => Object.assign({ name: 'coral-go', display_name: '', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', branch: 'feat/long-branch-name', repo_name: 'coral', working_directory: '/work/coral-project', context_pct: 10, working: false, waiting_for_input: false, not_started: false, stuck: false, sleeping: false, awaiting_user: false, done: false, board_project: '', board_unread: 0 }, o);
    const ROWS = [
        base({ session_id: 'o1', display_name: 'Worker', working: true }),
        base({ session_id: 'o2', display_name: 'Asker', waiting_for_input: true, waiting_kind: 'permission' }),
        base({ session_id: 'o3', display_name: 'Held', board_project: 'team-a', board_unread: 2, skipped_send: { why: 'a prompt is open', what: 'nudge' } }),
        base({ session_id: 'o4', display_name: 'Asker and held', waiting_for_input: true, waiting_kind: 'question', board_project: 'team-a', board_unread: 1, skipped_send: { why: 'a prompt is open', what: 'nudge' } }),
        base({ session_id: 'o5', display_name: 'Idler' }),
    ];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, root, rowH] of [['1280', 1280, 800, false, '#live-sessions-list', [34, 38]], ['390', 390, 844, true, '#mobile-session-list', [43, 46]]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(ROWS)}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            await waitFor(`document.querySelectorAll('${root} .session-group-item').length >= 5`, `${label}: the rows`, 6000);
            const rows = await ev(`[...document.querySelectorAll('${root} .session-group-item')].map(li => { const r = li.getBoundingClientRect(), name = li.querySelector('.session-label'); return { id: li.dataset.sessionId, h: Math.round(r.height), weight: name ? getComputedStyle(name).fontWeight : null, nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '16')) : 0, chips: [...li.querySelectorAll('.chip')].filter(c => c.getClientRects().length).map(c => c.textContent.trim()), chipPx: (c => c ? parseFloat(getComputedStyle(c).fontSize) : 0)(li.querySelector('.session-state-pill')), extra: ['.session-goal', '.session-model', '.session-worktree-line', '.session-line2', '.session-held-line', '.session-mobile-meta', '.session-mobile-banner-row', '.session-ctx-pill'].filter(s => li.querySelector(s)), dot: !!li.querySelector('.session-dot') }; })`);
            const by = id => rows.find(r => r.id === id);
            for (const r of rows) {
                assert.ok(r.h >= rowH[0] && r.h <= rowH[1], `${label}: ${r.id} is one line, ${rowH[0]} to ${rowH[1]} px (${r.h}) ${JSON.stringify(r)}`);
                assert.deepEqual(r.extra, [], `${label}: ${r.id} has no goal, model, branch, held or phone-card line ${JSON.stringify(r)}`);
                assert.ok(r.dot && r.chips.length <= 1, `${label}: ${r.id} is a dot, a name and at most one chip ${JSON.stringify(r)}`);
                assert.ok(Number(r.weight) === 500, `${label}: the name is 13/500, nothing bolder (${r.weight})`);
            }
            assert.deepEqual(by('o1').chips.concat(by('o5').chips), [], `${label}: a working agent and an idle one have no chip`);
            assert.match(by('o2').chips[0] || '', /Needs input/, `${label}: an agent that asks has the Needs input chip`);
            if (mobile) assert.equal(by('o2').chipPx, 13, `${label}: the phone's chip is 13 px (the one thing that says an agent waits), the row still one line ${JSON.stringify(by('o2'))}`);
            assert.deepEqual(by('o3').chips, ['Message held'], `${label}: an agent whose message was held has "Message held"`);
            assert.match(by('o4').chips[0] || '', /Needs input/, `${label}: Needs you wins over the hold`);
            assert.equal(by('o4').chips.length, 1, `${label}: one chip`);
            console.log(`PASS ${label}: one line, a dot, a name, at most one chip`);
            if (mobile) { // a phone's header has no room: one tap on Details shows the folder, branch and model
                await ev(`window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
                await waitFor(`document.getElementById('agent-phone-details') && !document.getElementById('agent-phone-details').hidden && document.getElementById('agent-phone-details').getClientRects().length > 0`, 'the Details disclosure on a phone', 8000);
                const sum = await ev(`(() => { const d = document.getElementById('agent-phone-details'); return { open: d.open, h: Math.round(d.querySelector('summary').getBoundingClientRect().height), text: d.querySelector('summary').textContent.trim() }; })()`);
                assert.equal(sum.text, 'Details'); assert.equal(sum.open, false, 'closed until asked'); assert.ok(sum.h >= 44, `a 44 px target ${JSON.stringify(sum)}`);
                await ev(`document.querySelector('#agent-phone-details > summary').click(); true`);
                const dd = await ev(`[...document.querySelectorAll('#agent-phone-details .facts-row')].filter(r => !r.hidden).map(r => r.querySelector('dt').textContent + ': ' + r.querySelector('dd').textContent)`);
                assert.ok(dd.some(x => /^Context: ctx 10%/.test(x)) && dd.some(x => /^Folder: .*coral-project/.test(x)) && dd.some(x => /^Branch: .*long-branch-name/.test(x)) && dd.some(x => /^Model: .*Opus/.test(x)), `Details has the folder, the branch and the model ${JSON.stringify(dd)}`);
                console.log('PASS 390: Details shows the folder, branch and model');
            }
            if (!mobile) { // nothing is lost: the agent's own page header has the branch, the folder and the model with its level (the row says none of them)
                await ev(`window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
                await waitFor(`!document.getElementById('terminal-header-model')?.hidden && !document.getElementById('terminal-header-folder')?.hidden && !document.getElementById('terminal-header-branch')?.hidden`, 'the header: model, folder and branch', 8000);
                const hd = await ev(`({ model: document.querySelector('#terminal-header-model .terminal-folder-text').textContent, folder: document.querySelector('#terminal-header-folder .terminal-folder-text').textContent, folderTip: document.getElementById('terminal-header-folder').title, branch: document.querySelector('#terminal-header-branch .terminal-branch-text').textContent })`);
                assert.match(hd.model, /Opus/, `the header names the model ${JSON.stringify(hd)}`); assert.match(hd.model, /ctx 10%/, `and the context use (the row's pill moved here) ${JSON.stringify(hd)}`);
                assert.ok(hd.folder.includes('coral-project') && hd.folderTip === '/work/coral-project', `and the folder, with its full path on hover ${JSON.stringify(hd)}`);
                assert.ok(hd.branch.includes('long-branch-name'), `and the branch beside it ${JSON.stringify(hd)}`);
                console.log('PASS 1280: the header has the branch, the folder and the model');
                await Emulation.setDeviceMetricsOverride({ width: 1024, height: 800, deviceScaleFactor: 1, mobile: false }); // a header this narrow (the side panel takes half) has no room for the model line: Details has it
                await waitFor(`getComputedStyle(document.getElementById('terminal-header-model')).display === 'none' && !document.getElementById('agent-phone-details').hidden && document.getElementById('agent-phone-details').getClientRects().length > 0`, '1024: the header model line gives way to Details', 6000);
                assert.equal(await ev(`(() => { const h = document.querySelector('#live-session-view .terminal-header'); return h.scrollWidth - h.clientWidth <= 1; })()`), true, '1024: the header does not overflow');
                console.log('PASS 1024: the header gives the model line to Details and does not overflow');
            }
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
