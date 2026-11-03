// A question shows the goal and task it was asked about (#12194, the operator's comment on #12143; the board carries them since #12164): the dialog has a "Goal #7: Ship the beta · Task #12: Fix login" line under who asked, each a
// link that opens that goal or task in the Inbox in place; the question's Needs you row says "Goal #7 · Task #12" after its name (the titles in its tooltip); a question about neither shows nothing. A question from another
// computer shows the words without a link. 1280 and 390 px; the question route is stubbed (as in operator_asks_browser).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HOSTILE = '@Operator look at this: <img src=x onerror="window.__pwned=1"> and <script>window.__pwned=2</script>\n\nA second paragraph, with <b onmouseover="window.__pwned=3">bold</b> html.';
const OPERATOR_TEXT = '@Operator TEST ITEM, safe to answer any way: this is a test request so you can reproduce the disappearing-inbox issue.\n\nAnswering or approving it **changes nothing** on the team. Please note what else, if anything, disappears from your Inbox when you answer it:\n\n- the row in Needs you\n- the badge\n\nDetails: [the board](https://example.com/board).';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, what] of [[1280, 800, false, 'task'], [1280, 800, false, 'goal'], [1280, 800, false, 'none'], [390, 844, true, 'task'], [390, 844, true, 'goal'], [390, 844, true, 'none']]) { // one scenario a fresh page: an in-place route leaves the page
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`); // each scenario starts clean: the last one's in-place route is remembered
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const at = `${w}: `;
            // the server's list, and the posts the page makes
            await ev(`(() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', goal_id: 7, goal_title: 'Ship the beta', task_id: 12, task_title: 'Fix the login page', text: ${JSON.stringify(OPERATOR_TEXT)}, at: new Date(Date.now() - 7 * 60000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 43, asker: 'QA', text: ${JSON.stringify(HOSTILE)}, at: new Date(Date.now() - 7200000).toISOString() }];
                window.__posts = []; window.__failPost = false; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push({ url, body }); if (window.__failPost) return json({ error: 'too many messages; retry in 20s' }, 429);
                        window.__asks = window.__asks.filter(a => !(body.content.startsWith('@' + a.asker + ' ') && (a.kind === 'wait' || body.reply_to === a.id))); return json({ id: 99 }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, at + 'three rows of Needs you (' + what + ')', 10000).catch(async e => { console.error('STATE', await ev('location.pathname + " rows=" + document.querySelectorAll("#group-table-view tbody tr").length + " tab=" + (localStorage.getItem("coral.inbox.tab") || "")')); throw e; });
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => ({ who: (r.querySelector('.inbox-review-from') || {}).textContent || '', mark: (r.querySelector('.inbox-review-earlier') || {}).textContent || '', tip: (r.querySelector('.inbox-review-earlier') || {}).title || '' }))`);
            const orch = rows.find(r => r.who === 'Orchestrator'), dev = rows.find(r => r.who === 'Dev');
            assert.ok(orch && orch.mark === 'Goal #7 \u00b7 Task #12' && /Ship the beta/.test(orch.tip) && /Fix the login page/.test(orch.tip) && /named by Orchestrator/.test(orch.tip), at + "the row says which goal and task, with their titles in its tooltip: " + JSON.stringify(orch));
            assert.ok(dev && dev.mark === '', at + 'a question about neither shows nothing on its row: ' + JSON.stringify(dev));
            // the dialog: a line of links
            if (what !== 'none') { // the question about a goal and a task: its dialog and a link
                await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
                await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the dialog opens', 4000);
                const d = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), p = d.querySelector('.inbox-ask-subjects'), sub = d.querySelector('.inbox-ask-sub'); return { shown: !!p && !p.hidden, buttons: p ? [...p.querySelectorAll('button')].map(b => [b.dataset.kind, b.textContent]) : [], text: p ? p.textContent : '', below: !!p && !!sub && p.getBoundingClientRect().top >= sub.getBoundingClientRect().bottom - 1 }; })()`);
                assert.ok(d.shown && d.below && JSON.stringify(d.buttons) === JSON.stringify([['goal', 'Goal #7'], ['task', 'Task #12']]), at + 'the dialog has the goal and the task as links under who asked: ' + JSON.stringify(d));
                assert.ok(/^About Goal #7 \u00b7 Task #12$/.test(d.text), at + 'the line says the asker named them: ' + d.text);
                    if (what === 'task' && process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/ask-subjects-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-subject[data-kind="${what}"]').click(); true`);
                await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'opening it closes the dialog', 4000);
                await waitFor(`/\\/${what}s/.test(location.pathname)`, at + `the ${what} opens in the Inbox in place (` + await ev('location.pathname') + ')', 6000);
                assert.ok(await ev(`location.pathname.includes(${what === 'task' ? "'12'" : "'7'"}) || location.search.includes(${what === 'task' ? "'12'" : "'7'"}) || location.hash.includes(${what === 'task' ? "'12'" : "'7'"})`), at + `it is the ${what} the question named: ` + await ev('location.pathname + location.search + location.hash'));
                continue;
            }
            if (what !== 'none') continue;
            // a question about neither has no line
            await ev(`document.querySelector('button[aria-label="Answer the question of Dev"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the second question opens', 4000);
            assert.ok(await ev(`(() => { const p = document.querySelector('dialog.inbox-ask-dialog .inbox-ask-subjects'); return !p || p.hidden || !document.querySelector('dialog.inbox-ask-dialog').contains(p); })()`), at + 'a question about neither shows no line');
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-primary)').click(); true`);
        }
    } finally { await client.close(); }
    console.log('ask_subject_links_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
