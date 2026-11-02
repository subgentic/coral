// The goal and task links of a question (#12227, Hermes Agent Investigation's review of #12194): a question from ANOTHER computer shows its goal and task as words with no link (a link would open this computer's goal of the same number);
// hidden characters in a goal or task title are written out, not drawn; and on a touch screen a goal or task link is a 44 px target. The question route is stubbed (as in ask_subject_links_browser).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, remote] of [[1280, 800, false, true], [1280, 800, false, false], [390, 844, true, false], [390, 844, true, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const at = `${w}${remote ? ' (from another computer)' : ' (this computer)'}: `;
            await ev(`(() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', ${remote ? "server: 'srv_far_away', " : ''}goal_id: 7, goal_title: 'Ship\\u202Ethe\\u200B beta', task_id: 12, task_title: 'Fix the login\\u0007 page', text: '@Operator may I go ahead?', at: new Date(Date.now() - 7 * 60000).toISOString() }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('button[aria-label="Answer the question of Orchestrator"]')`, at + 'the question row', 10000);
            await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the dialog opens', 4000);
            const d = await ev(`(() => { const p = document.querySelector('dialog.inbox-ask-dialog .inbox-ask-subjects'); return { text: p.textContent, buttons: [...p.querySelectorAll('button, a')].map(b => ({ kind: b.dataset.kind, h: Math.round(b.getBoundingClientRect().height) })) }; })()`);
            assert.ok(!/[\u202e\u200b\u0007]/.test(d.text) && /Ship.*beta/.test(d.text) && /Fix the login.* page/.test(d.text) && d.text.length > 'About Goal #7: Ship the beta · Task #12: Fix the login page (named by Orchestrator)'.length, at + 'hidden characters in the titles are written out, none are in the line: ' + JSON.stringify(d.text));
            if (remote) assert.deepEqual(d.buttons, [], at + 'a question from another computer shows the goal and the task as words, with no link (their numbers are that computer\'s): ' + JSON.stringify(d));
            else {
                assert.deepEqual(d.buttons.map(b => b.kind), ['goal', 'task'], at + 'a question from this computer has its two links: ' + JSON.stringify(d));
                if (mobile) assert.ok(d.buttons.every(b => b.h >= 44), at + 'the goal and task links are 44 px tall on a touch screen: ' + JSON.stringify(d.buttons));
            }
            assert.match(d.text, /^About Goal #7: .* · Task #12: .* \(named by Orchestrator\)$/, at + 'the line still says the asker named them: ' + d.text);
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-primary)').click(); true`);
        }
    } finally { await client.close(); }
    console.log('ask_subject_remote_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
