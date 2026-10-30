// The task's conversation on its Inbox page (#7703): under the text and above the reply box, a "Messages (N)" heading, each message a line "Name, time" (the person's own "You") over its text, oldest first, the last five
// with "Show earlier (N)", read again while the page is on screen and after a reply is sent, "N new" when an answer arrives out of sight; the old mount (no single-item page: Coral Hub's pinned version) has no thread and
// asks for none. Drives Chrome over CDP with the board's routes stubbed; the component is mounted with Coral's adapter into a host of its own.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const TASK = { id: 11, board_id: 'team-a', board_label: 'team-a', title: 'Review the release plan', priority: 'high', status: 'pending', created_by: 'Orchestrator', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), revision: 1 };
const STUB = `(() => { const real = window.fetch; const J = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
    window.__tasks = [${JSON.stringify(TASK)}]; window.__msgs = []; window.__nextId = 1; window.__reqs = [];
    window.__post = (from, content, mine) => { window.__msgs.push({ id: window.__nextId++, subscriber_id: from, content, created_at: new Date(Date.now() - 60000).toISOString(), task_id: 11 }); };
    window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.origin), p = url.pathname, m = (o && o.method) || 'GET'; window.__reqs.push(m + ' ' + p + url.search);
        if (p === '/api/board/tasks' && m === 'GET') return J({ tasks: window.__tasks });
        if (/^\\/api\\/board\\/team-a\\/tasks\\/11$/.test(p) && m === 'GET') return J({ body: 'Please check the plan and say what is missing.', created_by: 'Orchestrator', status: 'pending' });
        if (p === '/api/board/team-a/messages/all' && m === 'GET') return J(window.__msgs.filter(x => String(x.task_id) === url.searchParams.get('task_id')));
        if (p === '/api/board/team-a/tasks/11/reply' && m === 'POST') { const b = JSON.parse(o.body); window.__post('Operator', '@Orchestrator: ' + b.content); return J({ ok: true, notified: ['Orchestrator'], task_id: 11 }); }
        return real(u, o); }; return true; })()`;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const mount = (opts, hostId = 'qa-thread-host') => ev(`(async () => { document.getElementById(${JSON.stringify(hostId)})?.remove(); const h = document.createElement('div'); h.id = ${JSON.stringify(hostId)}; document.body.append(h);
        const pm = await import(${MOD} + 'inbox_panel.js'), ic = await import(${MOD} + 'inbox_coral.js'), ov = await import(${MOD} + 'overload.js'); window.__inbox = pm.mountInbox(h, ic.coralInboxAdapter, Object.assign(${opts}, { poll: (fn, ms) => ov.pollEvery(fn, ms) })); return true; })()`);
    const items = () => ev(`[...document.querySelectorAll('#qa-thread-host .ibx-thread-item')].map(li => ({ who: li.querySelector('.ibx-thread-who').textContent, text: li.querySelector('.ibx-thread-text').textContent.trim(), mine: li.classList.contains('ibx-thread-mine'), title: !!li.querySelector('.ibx-thread-who').title }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);

        console.log('the old mount (no single-item page): no thread, no read of the conversation');
        await mount(`{ load: true, region: false }`, 'qa-old-host');
        await waitFor(`!!document.querySelector('#qa-old-host .ibx-task-head')`, 'the old mount\'s list', 6000);
        await ev(`document.querySelector('#qa-old-host .ibx-task-head').click(); true`);
        await waitFor(`!!document.querySelector('#qa-old-host .ibx-reply')`, 'its task open with the reply box', 6000);
        assert.equal(await ev(`!!document.querySelector('#qa-old-host .ibx-thread')`), false, 'no thread in the list mount');
        assert.equal(await ev(`window.__reqs.some(r => r.includes('/messages/all'))`), false, 'and it never asks for the conversation');
        await ev(`document.getElementById('qa-old-host').remove(); true`);

        console.log('the single-item page: the heading, the empty line, the box under it');
        await mount(`{ region: false, only: { project: 'team-a', id: 11 }, threadPollMs: 300 }`);
        await waitFor(`!!document.querySelector('#qa-thread-host .ibx-thread')`, 'the thread', 6000);
        const order = await ev(`(() => { const t = document.querySelector('#qa-thread-host .ibx-task-body').children; return [...t].map(e => e.className.split(' ')[0]); })()`);
        assert.ok(order.indexOf('ibx-panel') < order.indexOf('ibx-thread') && order.indexOf('ibx-thread') < order.indexOf('ibx-reply'), 'the text, then the thread, then the reply box: ' + order.join());
        assert.equal(await ev(`document.querySelector('#qa-thread-host .ibx-thread-head').textContent`), 'Messages');
        assert.equal(await ev(`document.querySelector('#qa-thread-host .empty-state.empty-state-tight').textContent`), 'No messages about this task yet.');
        assert.equal(await ev(`(() => { const e = document.querySelector('#qa-thread-host .ibx-thread-head'), c = getComputedStyle(e); return c.fontSize + '/' + c.fontWeight; })()`), '14px/600', 'the heading is 14/600');

        console.log('the person replies: their message joins the thread at once, as You, without the creator\'s mention');
        await ev(`(() => { const ta = document.querySelector('#qa-thread-host .ibx-reply-input'); ta.value = 'How far along is it?'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#qa-thread-host .ibx-send').click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#qa-thread-host .ibx-thread-item').length === 1`, 'the reply in the thread', 6000);
        let it = await items();
        assert.match(it[0].who, /^You, /); assert.equal(it[0].text, 'How far along is it?'); assert.ok(it[0].mine && it[0].title, 'mine, with the exact time as the title');
        assert.equal(await ev(`document.querySelector('#qa-thread-host .ibx-thread-head').textContent`), 'Messages (1)');

        console.log('an agent answers: it arrives by itself, newest last, with its name');
        await ev(`window.__post('Orchestrator', 'About half done: **two** of four steps.'); true`);
        await waitFor(`document.querySelectorAll('#qa-thread-host .ibx-thread-item').length === 2`, 'the answer by the poll', 6000);
        it = await items();
        assert.match(it[1].who, /^Orchestrator, /); assert.equal(it[1].text, 'About half done: two of four steps.'); assert.equal(it[1].mine, false);
        assert.equal(await ev(`document.querySelectorAll('#qa-thread-host .ibx-thread-text strong').length`), 1, 'the text goes through the safe Markdown renderer');
        assert.equal(await ev(`new Set([...document.querySelectorAll('#qa-thread-host .ibx-thread-who')].map(e => getComputedStyle(e).color)).size`), 1, 'one colour for every name line, You and the agents alike (UI/UX)');

        console.log('a long thread: the last five, Show earlier (N) above, all of them after it');
        await ev(`for (let i = 0; i < 6; i++) window.__post('Orchestrator', 'more ' + i); true`);
        await waitFor(`document.querySelector('#qa-thread-host .ibx-thread-head').textContent === 'Messages (8)'`, 'eight messages', 6000);
        assert.equal(await ev(`document.querySelectorAll('#qa-thread-host .ibx-thread-item').length`), 5);
        assert.equal(await ev(`document.querySelector('#qa-thread-host .ibx-thread-earlier').textContent`), 'Show earlier (3)');
        assert.equal((await items()).at(-1).text, 'more 5', 'the newest is last');
        await ev(`document.querySelector('#qa-thread-host .ibx-thread-earlier').click(); true`);
        await waitFor(`document.querySelectorAll('#qa-thread-host .ibx-thread-item').length === 8 && document.querySelector('#qa-thread-host .ibx-thread-earlier').hidden`, 'all eight shown', 4000);

        console.log('an answer out of sight says "N new" and does not move the page');
        await ev(`document.body.style.paddingBottom = '3000px'; document.querySelector('#qa-thread-host').scrollIntoView(); window.scrollTo(0, 0); document.getElementById('qa-thread-host').style.marginTop = '2000px'; window.__post('Orchestrator', 'late answer'); true`);
        await waitFor(`!document.querySelector('#qa-thread-host .ibx-thread-new').hidden`, 'the "N new" line', 6000);
        assert.equal(await ev(`document.querySelector('#qa-thread-host .ibx-thread-new').textContent`), '1 new');
        assert.equal(await ev(`scrollY`), 0, 'the page did not move');
        await ev(`document.querySelector('#qa-thread-host .ibx-thread-new').click(); true`);
        await waitFor(`document.querySelector('#qa-thread-host .ibx-thread-new').hidden`, 'the line goes when followed', 3000);
        console.log('a Coral Hub operator post is named by its hub user, and only the local Operator is You (Security #7724)');
        await ev(`window.__msgs.push({ id: window.__nextId++, subscriber_id: 'Operator', hub_user: 'hub-user-1234abcd', content: 'from the hub', created_at: new Date().toISOString(), task_id: 11 }); true`);
        await waitFor(`document.querySelector('#qa-thread-host .ibx-thread-head').textContent === 'Messages (10)'`, 'the hub post', 6000);
        it = await items();
        assert.match(it.at(-1).who, /^hub-user-1234abcd, /); assert.equal(it.at(-1).mine, false, 'not drawn as You');
        assert.equal(it.filter(x => x.mine).length, 1, 'the one You is the person\'s own reply');
        console.log('PASS inbox_thread');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
