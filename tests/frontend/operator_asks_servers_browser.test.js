// Questions to the Operator are read from every computer the page reads (#12612, coral-hub #156454): operator_asks.js made a bare fetch('/api/operator-asks'), and through Coral Hub a bare /api path is the Hub's own, which has none, so no
// agent's question reached Needs you. Now each source is asked through serverFetch (this computer's plain path, a registered computer's /api/remote/<id>/ path), a row from another computer carries its computer's id (the
// dialog and the row know it is not this one's), two computers' questions of one team name and one number are two rows with two keys, a computer that cannot be read keeps the rows it had, and the reply and the Dismiss go back to
// the question's own computer. The Hub's own page is the same code with the local computer left out of the sources (inboxSources, unit-pinned elsewhere); here the page is a local one that has registered computers. Real isolated server serves the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.hub = true; state.servers = [{ id: 'box-1', status: 'online' }, { id: 'box-2', status: 'online' }, { id: 'box-3', status: 'offline' }];
            window.__calls = []; window.__box2 = 'fail'; const orig = window.fetch.bind(window);
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u); const m = (o && o.method) || 'GET';
                if (/operator-asks|\\/messages$|\\/close$/.test(url)) window.__calls.push(m + ' ' + url);
                if (url === '/api/operator-asks') return json([{ board: 'team', kind: 'ask', id: 1, asker: 'Dev', text: 'a question on this computer', at: new Date().toISOString() }]);
                if (url === '/api/remote/box-1/api/operator-asks') return json([{ board: 'team', kind: 'ask', id: 1, asker: 'QA', text: 'a question on box one', at: new Date().toISOString() }]);
                if (url === '/api/remote/box-2/api/operator-asks') return window.__box2 === 'fail' ? json({ error: 'down' }, 502) : json([{ board: 'site', kind: 'wait', id: 0, asker: 'Ops', text: 'waiting on box two', at: new Date().toISOString() }]);
                if (/\\/messages$/.test(url) && m === 'POST') return json({ id: 9 }, 201);
                if (/\\/close$/.test(url) && m === 'POST') return json({ ok: true });
                return orig(u, o); }; return true; })()`);
        const read = () => ev(`(async () => { const m = await import(${S} + 'operator_asks.js'); await m.refreshOperatorAsks(true); return m.operatorAsks().map(a => ({ asker: a.asker, server: a.server || '', key: m.askKey(a) })); })()`);

        let rows = await read();
        assert.deepEqual(rows.map(r => r.asker).sort(), ['Dev', 'QA'], 'the questions of this computer and of box-1 are read; box-2 failed and box-3 is offline: ' + JSON.stringify(rows));
        assert.equal(rows.find(r => r.asker === 'Dev').server, '', 'a question of this computer carries no server');
        assert.equal(rows.find(r => r.asker === 'QA').server, 'box-1', 'a question of another computer carries its id');
        assert.equal(new Set(rows.map(r => r.key)).size, 2, 'one team name and one number on two computers are two keys: ' + JSON.stringify(rows));
        assert.equal(rows.find(r => r.asker === 'Dev').key, 'operator-ask:team:ask:1', 'this computer\'s key is as it was');
        const calls = await ev(`window.__calls.filter(c => /operator-asks/.test(c))`);
        assert.ok(!calls.some(c => /box-3/.test(c)), 'an offline computer is not asked: ' + JSON.stringify(calls));
        assert.ok(calls.includes('GET /api/remote/box-1/api/operator-asks') && calls.includes('GET /api/remote/box-2/api/operator-asks'), 'each online computer is asked through its own path: ' + JSON.stringify(calls));

        await ev(`window.__box2 = 'ok'; true`);
        rows = await read();
        assert.deepEqual(rows.map(r => r.asker).sort(), ['Dev', 'Ops', 'QA'], 'box-2 answers: its wait is a row: ' + JSON.stringify(rows));
        await ev(`window.__box2 = 'fail'; true`);
        rows = await read();
        assert.deepEqual(rows.map(r => r.asker).sort(), ['Dev', 'Ops', 'QA'], 'a computer that cannot be read keeps the rows it had: ' + JSON.stringify(rows));

        // the reply and the Dismiss go back to the question's own computer
        await ev(`window.__calls = []; (async () => { const m = await import(${S} + 'operator_asks.js'); const q = m.operatorAsks().find(a => a.asker === 'QA'), d = m.operatorAsks().find(a => a.asker === 'Dev');
            await m.replyToAsk(q, 'yes, ship it'); await m.replyToAsk(d, 'hold'); const ig = await import(${S} + 'ask_ignore.js'); await ig.closeAsk(q); await ig.closeAsk(d); return true; })()`);
        const sent = await ev(`window.__calls`);
        assert.ok(sent.includes('POST /api/remote/box-1/api/board/team/messages'), 'the reply to box-1\'s question goes to box-1: ' + JSON.stringify(sent));
        assert.ok(sent.includes('POST /api/board/team/messages'), 'the reply to this computer\'s goes to this computer: ' + JSON.stringify(sent));
        assert.ok(sent.includes('POST /api/remote/box-1/api/board/team/asks/1/close') && sent.includes('POST /api/board/team/asks/1/close'), 'the close goes to the question\'s own computer: ' + JSON.stringify(sent));
    } finally { await client.close(); }
    console.log('operator_asks_servers_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
