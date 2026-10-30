// The visual audit's words and chrome (#9456, items 4, 8 and 16), on the real pages at 1280 and 390 px: the create buttons are the verb and the thing ("New agent" in the sidebar, "New" in the phone's
// list, "New task" on the Tasks tab, no plus sign); a dialog has no Close X and Cancel closes it; and the agent row's one chip ("Needs input") is sentence case, not upper case (#9686: an agent row is the dot, the name and at most one chip; "Idle" is the dot's now). The job chips' words
// (Passed, Failed) are pinned in jobs_screen, jobs_audit_fixes and job_exit_reason. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'words-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const cancel = footer => `[...document.querySelectorAll('${footer} button')].find(b => b.textContent.trim() === 'Cancel').click(); true`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Orchestrator', name: 'Orchestrator', role: 'Orchestrator', job_title: 'Orchestrator', working_directory: '/tmp/x', agent_type: 'claude' });
        await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Orchestrator', title: 'A task', body: 'x', priority: 'medium', assigned_to: 'Orchestrator' });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            // create buttons: the verb and the thing, no plus sign
            if (mobile) { // a phone has no New button in a header (#11116): an empty home has a card for each kind, and with agents the + button opens a menu (mobile.css); here the home is empty
                await waitFor(`[...document.querySelectorAll('#mobile-agent-list .empty-launch strong')].some(e => e.getClientRects().length)`, at + 'the New agent card', 8000);
                assert.deepEqual(await ev(`[...document.querySelectorAll('#mobile-agent-list .empty-launch strong')].map(e => e.textContent.trim()).slice(0, 2)`), ['New agent', 'New project'], at + 'the create cards are the verb and the thing, no plus sign');
            } else {
                const label = '.sidebar-new-btn-full';
                await waitFor(`[...document.querySelectorAll(${JSON.stringify(label)})].some(e => e.getClientRects().length)`, at + 'the New agent button', 8000);
                assert.equal(await ev(`[...document.querySelectorAll(${JSON.stringify(label)})].filter(e => e.getClientRects().length)[0].textContent.trim()`), 'New agent', at + 'the create button is the verb and the thing, no plus sign');
            }
            await shot(`words-home-${w}`);
            await Page.navigate({ url: BASE + `/team/${B}/tasks` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await waitFor(`!!document.querySelector('.btn-create-task')`, at + 'the Tasks tab', 10000);
            assert.equal(await ev(`document.querySelector('.btn-create-task').textContent.trim()`), 'New task', at + 'the Tasks bar says New task');
            // a dialog: no Close X, Cancel closes it
            await ev(`window.showJobModal().then(() => true)`); // the form loads on first use (#10218)
            await waitFor(`getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, at + 'New job', 8000);
            assert.equal(await ev(`!!document.querySelector('.modal-close-btn')`), false, at + 'no dialog has a Close X');
            assert.equal(await ev(`document.querySelector('#job-modal h3').textContent.trim()`), 'New job');
            await shot(`words-job-dialog-${w}`);
            await ev(cancel('#job-footer'));
            await waitFor(`getComputedStyle(document.getElementById('job-modal')).display === 'none'`, at + 'Cancel closes New job', 8000);
            await ev(`window.showWorkflowCreateModal(); true`);
            await waitFor(`getComputedStyle(document.getElementById('wf-create-modal')).display !== 'none'`, at + 'New workflow', 8000);
            await ev(cancel('#wf-footer'));
            await waitFor(`getComputedStyle(document.getElementById('wf-create-modal')).display === 'none'`, at + 'Cancel closes New workflow', 8000);
            await ev(`window.showConfirmModal('Delete workflow', 'Delete workflow "x"?', () => {}, undefined, { label: 'Delete workflow', danger: true }); true`);
            assert.equal(await ev(`document.getElementById('confirm-modal-title').textContent`), 'Delete workflow', at + 'a confirm title is sentence case');
            await shot(`words-confirm-${w}`);
            await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
        }
        // the agent row's status on the phone's list, drawn: sentence case, not upper-cased (an agent that needs you; the phone has no chip since #10691, the state is the row's second line)
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.switchNavTab('agents'); window._coralSetLiveSessions([{ session_id: 'i1', name: 'idle-1', agent_type: 'claude', working_directory: '/tmp/x', sleeping: false, display_name: 'Idle One', model: 'claude-opus-5-5', summary: 'Waiting for work', waiting_for_input: true }]); true`);
        await waitFor(`!!document.querySelector('#mobile-session-list .session-status-line') && document.querySelector('#mobile-session-list .session-status-line').getClientRects().length > 0`, 'the phone row status line, drawn', 8000);
        const chip = await ev(`(() => { const c = document.querySelector('#mobile-session-list .session-status-line'); return { text: c.textContent.trim(), transform: getComputedStyle(c).textTransform }; })()`);
        assert.equal(chip.transform, 'none', 'the row status is not upper-cased: ' + JSON.stringify(chip));
        assert.match(chip.text, /^[A-Z][a-z]/, 'its words are sentence case: ' + JSON.stringify(chip));
        await shot('words-phone-card-390');
        console.log('PASS ui words: create buttons without a plus, no Close X and Cancel closes, a sentence-case confirm title and phone row status');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
