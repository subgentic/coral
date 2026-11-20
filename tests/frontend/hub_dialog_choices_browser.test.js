// #15010 (2), from #14780: through the Hub a Needs you question shows its choices as buttons with names (not unlabeled icons): a Yes/No question reads Yes and No, a question with its own choices reads
// them, and one press answers through the computer's route (/api/remote/<computer>/api/sessions/live/<id>/answer-prompt). The Hub's feed carries the waiting agent of a computer; the card is read through it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
// #19864 (the Operator: "the hooks isn't in my inbox on CoralHub"): an agent stuck at a terminal dialog Coral read from its screen (Codex's "Hooks need review", on the row as at_dialog, no hook, waiting_for_input false)
// is a Needs you row through the Hub with its menu's own options as buttons, no default and none chosen for the person, and a press answers through the computer's answer-prompt route. A dialog still inside its minutes is no row.
const OPTIONS = [{ n: 1, label: 'Review hooks', action: 'select' }, { n: 2, label: 'Trust all and continue', action: 'select' }, { n: 3, label: 'Continue without trusting', action: 'select' }];
const SHOWN = OPTIONS.map(o => o.label);
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, hubFeed: true, inbox: 'native', needs: 'native' });
            await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
                window.__answers = [];
                window.__hubSessionPatch = s => s.session_id === 'hub-agent-2' ? { ...s, waiting_for_input: false, at_dialog: { since: new Date(Date.now() - 7 * 60000).toISOString(), after_min: 5, notify: true } }
                    : s.session_id === 'hub-agent-0' ? { ...s, waiting_for_input: false, at_dialog: { since: new Date(Date.now() - 60000).toISOString(), after_min: 5, notify: true } } : s;
                const real = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), p = url.pathname, m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/api\\/sessions\\/live\\/[^/]+\\/answer-prompt$/.test(p)) { window.__answers.push({ path: p, body: JSON.parse(o.body) }); return json({ ok: true }); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat$/.test(p)) return json({ messages: [], total: 0, prompt_options: { title: 'Hooks need review', question: 'Hooks need review 2 hooks are new or changed. Hooks can run outside the sandbox after you trust them.', ask_id: 'ask-1', multi: false, options: ${JSON.stringify(OPTIONS)} } });
                    return real(u, o); };
            })()` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'settings');
            if (mobile) { await ev(`document.getElementById('nav-select').click(); true`); await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, at + 'Inbox in the view dropdown', 8000); await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`); }
            else await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S}+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.querySelectorAll('#group-table-view .inbox-answer').length === ${SHOWN.length}`, at + 'the dialog\'s options are buttons on its row', 15000); }
            catch (e) { throw new Error(e.message + ' :: rows ' + await ev(`JSON.stringify([...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)))`)); }
            const names = await ev(`[...document.querySelectorAll('#group-table-view .inbox-answer')].map(b => b.textContent.trim())`);
            assert.deepEqual(names, SHOWN, at + 'the menu\'s own words, in its order');
            assert.equal(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].filter(r => r.textContent.includes('it is at a dialog')).length`), 1, at + 'one dialog row: the dialog still inside its minutes is none');
            assert.equal(await ev(`document.querySelectorAll('#group-table-view .inbox-answer.primary, #group-table-view .inbox-answer[data-default]').length`), 0, at + 'no option is made the default');
            assert.deepEqual(await ev(`window.__answers.length`), 0, at + 'nothing was answered for the person');
            await ev(`new Promise(r => setTimeout(r, 900))`); // sleep-ok: an answer ignores a press for its first 400 ms (the arm hold, #14302)
            await ev(`document.querySelectorAll('#group-table-view .inbox-answer')[2].click(); true`);
            await waitFor(`window.__answers.length === 1`, at + 'one press answers', 10000);
            const sent = await ev(`window.__answers[0]`);
            assert.match(sent.path, /^\/api\/remote\/m2\/api\/sessions\/live\/hub-agent-2\/answer-prompt$/, at + 'through the computer: ' + sent.path);
            assert.equal(sent.body.label, 'Continue without trusting', at + 'the label of the button pressed');
            assert.equal(sent.body.n, 3);
            console.log(`   \u2713 ${at}${SHOWN.join(' / ')}`);
        }
        console.log('PASS an agent at a dialog is a Hub Needs you row with its options');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exitCode = 1; });
