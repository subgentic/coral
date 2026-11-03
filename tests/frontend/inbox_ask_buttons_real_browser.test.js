// Buttons an agent put on a question to the Operator (#11445, #11643), end to end against the REAL server: a stood-in agent with a real session token posts asks with buttons; the Operator's Needs you opens the
// question with each button and what it DOES in the app's own words (the agent's label is text); a wake of an agent that is not asleep fails and is given back; opening a file or task keeps the question pending and reusable; a reply
// is posted by the server as a click on the agent's own label and closes its question; an agent's token cannot claim. 1280 and 390 px. No stubs.
const assert = require('node:assert/strict');
const { launchStandIn } = require('./helpers/stand_in_agent');
const BASE = require('./test_base').BASE;
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

async function httpJson(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
}

(async () => {
    const B = 'ab-' + Date.now().toString(36);
    let standIn = null, client = null, evp = null;
    try {
        const c = await connect(); client = c.client; const { Page, Emulation, ev, waitFor, PRELOAD, install } = c; evp = ev;
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const S = `(window.__coralStatic || '/static/')`;
        const person = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        standIn = await launchStandIn(httpJson, { displayName: 'Button Walker' });
        if (!standIn.sid) throw new Error('no stand-in agent: ' + standIn.diag);
        const tok = { 'X-Coral-Session-Token': standIn.token };
        // a member's session name is "<cli>-<session id>", as an agent that joins a team has it
        const liveList = await (await fetch(BASE + '/api/sessions/live')).json().catch(() => []);
        const live = (Array.isArray(liveList) ? liveList : liveList.sessions || []).find(x => x.session_id === standIn.sid) || {};
        assert.ok(live.agent_type, 'the stand-in is in the live list: ' + JSON.stringify(live));
        assert.ok((await httpJson('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Button Walker', job_title: 'Backend Dev', session_name: `${live.agent_type}-${standIn.sid}` })).status < 300);
        assert.ok((await person('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' })).status < 300);
        const t = await person('POST', `/api/board/${B}/tasks`, { title: 'Look here', body: 'a task to open', created_by: 'Operator', subscriber_id: 'Operator', assigned_to: 'Button Walker' });
        assert.ok(t.status < 300, 'a task to point at: ' + JSON.stringify(t));
        const taskId = t.data.id || (t.data.task && t.data.task.id);
        assert.ok(taskId, JSON.stringify(t.data));
        const ask = async (text, buttons) => { const r = await httpJson('POST', `/api/board/${B}/messages`, { subscriber_id: 'Button Walker', content: text, ask: true, buttons }, tok); assert.equal(r.status, 200, JSON.stringify(r)); return r.data.id; };
        const mine = async () => { const r = await person('GET', '/api/operator-asks'); assert.equal(r.status, 200); return r.data.filter(a => a.board === B); };

        // an agent's token cannot use a button, and a bad declaration is refused whole
        const bad = await httpJson('POST', `/api/board/${B}/messages`, { subscriber_id: 'Button Walker', content: '@Operator no?', ask: true, buttons: ['Run it=run:rm -rf /'] }, tok);
        assert.equal(bad.status, 400, 'a bad button refuses the post: ' + JSON.stringify(bad));
        const q1 = await ask('@Operator Which way? (one)', ['Go <b>ahead</b>=reply', `Look at it=open:task:${taskId}`, 'Wake it=wake:Button Walker']);
        const q2 = await ask('@Operator Ship it? (two)', ['Yes, ship it=reply']);
        await ask('@Operator Which way, on a phone? (three)', ['Go <b>ahead</b>=reply', `Look at it=open:task:${taskId}`, 'Wake it=wake:Button Walker']);
        let asks = await mine();
        assert.equal(asks.length, 3, JSON.stringify(asks));
        const first = asks.find(a => a.id === q1);
        assert.equal(first.buttons.length, 3);
        const claim403 = await httpJson('POST', `/api/board/${B}/asks/${q1}/buttons/${first.buttons[0].id}/claim`, {}, tok);
        assert.equal(claim403.status, 403, 'an agent token cannot claim: ' + JSON.stringify(claim403));

        // A real document button must leave both choices reusable. Wait for the action's final
        // refresh before asserting: checking as soon as the viewer opens missed the old settle race.
        const upload = await ev(`fetch('/api/board/${B}/operator-artifacts?session_id=${standIn.sid}', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Artifact-Name': 'design.md', 'X-Artifact-Media-Type': 'text/markdown' }, body: '# Document button regression\\nRead this design before deciding.' }).then(async r => ({ status: r.status, data: await r.json() }))`);
        assert.equal(upload.status, 201, JSON.stringify(upload));
        const documentQuestion = await ask('@Operator Read the design before deciding (document review)', [`Open document=open:artifact:${upload.data.id}`, 'Build the design=reply']);
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => m.selectInboxTab('needs')).then(() => true)`);
        const documentRow = `[...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.textContent.includes('(document review)'))`;
        await waitFor(`!!(${documentRow})`, 'the document question in Needs you', 15000);
        await ev(`(() => { const original = window.fetch; window.__askRefreshes = 0; window.__buttonSettles = 0; window.fetch = async function(u, ...args) { const r = await original.call(this, u, ...args); const path = String(u); if (path.includes('/api/operator-asks')) window.__askRefreshes++; if (/buttons\\/\\d+\\/settle/.test(path)) window.__buttonSettles++; return r; }; })()`);
        const reopenFromActivity = async () => {
            const record = await person('GET', '/api/activity');
            const action = record.data.actions.find(r => r.item_kind === 'question' && String(r.item_id) === String(documentQuestion));
            assert.ok(action, 'the question has an Activity record: ' + JSON.stringify(record));
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('activity')).then(() => true)`);
            const activityRow = `document.querySelector('#group-table-view tr[data-key="${action.id}"]')`;
            await waitFor(`!!(${activityRow})`, 'the question in Activity', 10000);
            assert.ok(await ev(`!!(${activityRow}).querySelector('.dt-primary')`), 'the question in Activity can be opened');
            await ev(`(${activityRow}).querySelector('.dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('.mb-message[data-message-id="${documentQuestion}"] [data-on-click="mb-msg-reply"]')`, 'Activity opens the original board question with Reply', 15000);
            assert.ok(await ev(`document.querySelector('.mb-message[data-message-id="${documentQuestion}"]').textContent.includes('(document review)')`), 'the original question can still be read');
        };
        for (let opening = 0; opening < 2; opening++) {
            await ev(`(${documentRow}).querySelector('button[aria-label^="Answer the question of"]').click(); true`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, 'reopen the same question', 6000);
            assert.equal(await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].filter(b => !b.disabled).length`), 2, 'both choices remain usable');
            const reads = await ev('window.__askRefreshes');
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].find(b => b.textContent === 'Open document').click(); true`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body')?.textContent.includes('Read this design before deciding.')`, 'the actual document opens', 10000);
            await waitFor(`window.__askRefreshes > ${reads}`, 'the action finishes refreshing Needs you', 10000);
            const pending = (await mine()).find(a => a.id === documentQuestion);
            assert.ok(pending && pending.buttons.length === 2 && pending.buttons.every(b => b.state === 'pending'), 'opening a document leaves the question and both buttons pending: ' + JSON.stringify(pending));
            assert.equal(await ev('window.__buttonSettles'), 0, 'navigation never sends a settle request');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await waitFor(`!!(${documentRow})`, 'the question remains in Needs you', 8000);
        }
        await reopenFromActivity(); // the same route works while the question is still pending
        assert.ok((await mine()).some(a => a.id === documentQuestion), 'opening Activity does not answer it');
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`!!(${documentRow})`, 'return to the unanswered question', 10000);
        await ev(`(${documentRow}).querySelector('button[aria-label^="Answer the question of"]').click(); true`);
        await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, 'answer after reading', 6000);
        await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].find(b => b.textContent === 'Build the design').click(); true`);
        await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, 'the reply finishes', 6000);
        assert.ok(!(await mine()).some(a => a.id === documentQuestion), 'the reply settles the question');
        await reopenFromActivity(); // settled questions stay readable and replyable

        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `, which = mobile ? '(three)' : '(one)';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => m.selectInboxTab('needs')).then(() => true)`);
            const rowOf = text => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.textContent.includes(${JSON.stringify(text)}))`;
            await waitFor(`!!(${rowOf(which)})`, at + 'the question is in Needs you', 15000);
            const answer = text => ev(`(${rowOf(text)}).querySelector('button[aria-label^="Answer the question of"]').click(); true`);
            const open = async text => { await answer(text); await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the question opens', 6000); };
            const toast = () => ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);

            // the dialog: every button, with what it does in the app's words; the label is text
            await open(which);
            const offers = await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer')].map(o => ({ label: o.querySelector('button').textContent, what: o.querySelector('.inbox-ask-offer-what').textContent, aria: o.querySelector('button').getAttribute('aria-label'), html: o.querySelector('button').innerHTML }))`);
            assert.equal(offers.length, 3, at + JSON.stringify(offers));
            assert.deepEqual(offers.map(o => o.what), ['Replies "Go <b>ahead</b>" as you', `Opens task #${taskId}`, 'Wakes Button Walker'], at + 'what each does, in our words');
            assert.ok(offers[0].html.includes('&lt;b&gt;') && !offers[0].html.includes('<b>'), at + 'the label is text, never markup: ' + offers[0].html);
            assert.ok(offers.every(o => o.aria.endsWith(': ' + o.what)), at + 'the accessible name says what it does');
            assert.ok(await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].every(b => b.getBoundingClientRect().height >= 44) && document.documentElement.scrollWidth <= innerWidth`), at + 'targets of 44 px, no sideways scroll');

            if (w === 1280) {
                await waitFor(`import(${S} + 'state.js').then(m => (m.state.liveSessions || []).some(s => s.session_id === ${JSON.stringify(standIn.sid)}))`, at + 'the agent is in the page\'s live list', 8000).catch(() => {}); // best effort: either way the wake cannot run (the agent is not asleep, or the page has not heard of it yet) and must be given back
                // Wake an agent that is not asleep: it fails in words and the button is given back (the question stays, all three buttons still there)
                await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].find(b => b.textContent === 'Wake it').click(); true`);
                await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the dialog closes on a click', 6000);
                await waitFor(`/not asleep|not running on this computer/.test([...document.querySelectorAll('.toast')].map(t => t.textContent).join(' '))`, at + 'it says why: ' + await toast(), 8000);
                asks = await mine();
                const again = asks.find(a => a.id === q1);
                assert.ok(again && again.buttons.every(b => b.state === 'pending'), at + 'the failed wake was given back: ' + JSON.stringify(again));
                // Open the task: navigation keeps the question pending
                await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
                await waitFor(`!!(${rowOf('(one)')})`, at + 'the question is still in Needs you', 8000);
                await open('(one)');
                await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].find(b => b.textContent === 'Look at it').click(); true`);
                await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'closes', 6000);
                const stillPending = (await mine()).find(a => a.id === q1);
                assert.ok(stillPending && stillPending.buttons.every(b => b.state === 'pending'), at + 'opening the task keeps all choices pending');
            } else {
                await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-primary)').click(); true`); // Close: nothing runs on a phone walk of the layout
                await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'closes', 6000);
            }
        }

        // a reply button: the server posts the stored label as a click and closes the question
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr')].some(r => r.textContent.includes('(two)'))`, 'the second question', 15000);
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.textContent.includes('(two)')).querySelector('button[aria-label^="Answer the question of"]').click(); true`);
        await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, 'the second question opens', 6000);
        await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].find(b => b.textContent === 'Yes, ship it').click(); true`);
        await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, 'closes', 6000);
        let reply = null;
        for (let i = 0; i < 40 && !reply; i++) {
            const m = await person('GET', `/api/board/${B}/messages/all`);
            reply = (m.data || []).find(x => x.subscriber_id === 'Operator' && /clicked the button labelled/.test(x.content) && x.content.includes('\"Yes, ship it\"'));
            if (!reply) await new Promise(r => setTimeout(r, 250)); // sleep-ok: the click's post
        }
        assert.ok(reply, 'the server posted the reply');
        assert.ok(reply.content.includes('@Button Walker') && reply.content.includes('"Yes, ship it"') && reply.content.includes('not a typed reply'), reply.content);
        assert.ok(!(await mine()).some(a => a.id === q2), 'the question is closed');
        console.log('inbox_ask_buttons_real_browser: ok');
    } finally { if (standIn) await standIn.stop().catch(() => {}); if (evp) await removeBoards(evp, [B]).catch(() => {}); if (client) await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
