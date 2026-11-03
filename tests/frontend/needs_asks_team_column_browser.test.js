// Questions to the Operator say which team asked in the Team column (#12649, the Operator: "the Team column is empty for mentions from another team's board, and drop the Waiting for column so the item text gets the room"): a question
// row's Team cell was blank by design (its team was in the item's own line), so a table of questions had a Team column of blanks, and a Waiting for column with nothing in it. Now each question names its team (the board's label, with its
// computer when a Hub reads several), and a column nobody has anything in is not drawn: no Waiting for for questions. 1280 px, the asks stubbed as in ask_item_browser. Real isolated server serves the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: '@Operator which release first?', at: new Date(Date.now() - 7 * 60000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 43, asker: 'QA', text: '@Operator Sorry, the "test" question just before this was my mistake and nothing needs doing about it; what it is for is that Mobile Dev now has a task about the Inbox bug and wants your word on its order.', at: new Date(Date.now() - 1800000).toISOString() }, { board: 'site', board_label: 'Site', kind: 'wait', id: 0, asker: 'Ops', text: '@Operator waiting on your word', at: new Date(Date.now() - 600000).toISOString() }];
            const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 4`, 'the four questions', 10000);
        await ev(framesJs(10));
        const t = await ev(`(() => { const T = '#group-table-view'; const heads = [...document.querySelectorAll(T + ' thead th')].filter(th => th.getClientRects().length && th.getBoundingClientRect().width > 4).map(th => th.textContent.trim().replace(/[↕↑↓]/g, '')); const col = heads.indexOf('Team'); const rows = [...document.querySelectorAll(T + ' tbody tr')].map(tr => { const cells = [...tr.children].filter(td => td.getClientRects().length && td.getBoundingClientRect().width > 4); return { asker: tr.textContent.slice(0, 14), team: col >= 0 ? (cells[col] || {}).textContent.trim() : null }; }); const item = document.querySelector(T + ' thead th').getBoundingClientRect().width; return { heads, rows, item: Math.round(item) }; })()`);
        assert.ok(t.heads.includes('Team'), 'a table of questions has a Team column: ' + JSON.stringify(t));
        const by = Object.fromEntries(t.rows.map(r => [r.asker.replace(/@.*/, ''), r.team]));
        assert.deepEqual(by, { Orchestrator: 'coral-hub', Dev: 'Sprout', QA: 'Sprout', Ops: 'Site' }, 'each question names the team that asked: ' + JSON.stringify(t));
        assert.ok(!t.heads.includes('Waiting for') && !t.heads.includes('What was asked'), 'no column nobody has anything in: ' + JSON.stringify(t.heads));
        const lines = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].find(tr => /^QA/.test(tr.textContent)).querySelector('td').innerText.split('\\n').map(x => x.trim()).filter(Boolean)`);
        assert.ok(lines.length >= 2 && !lines[lines.length - 1].startsWith(lines[lines.length - 2].slice(0, 20)) && !/^Sorry/.test(lines[lines.length - 1]), 'the line under the title is the rest of the words, not the title again: ' + JSON.stringify(lines));
        assert.ok(t.item >= 500, 'the item text has the room: ' + t.item);
    } finally { await client.close(); }
    console.log('needs_asks_team_column_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
