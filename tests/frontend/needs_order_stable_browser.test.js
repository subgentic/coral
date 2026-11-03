// Needs you keeps the order the person is looking at when a computer answers late (#12636, coral-hub's beta pass, finding 3): the Hub shows this computer's rows at once, then each registered computer's questions
// arrive over the next seconds, and the list was re-sorted by waiting time every time, so rows moved under a finger about to tap one. Now a row already shown stays where it is, a row that is new (even an older one)
// goes after them (the default sort puts the newest first, so a new one used to jump to the top), and a different search, filter or sort starts the order afresh. At 1280 and 390 px (a coarse pointer at 390), with the questions of one computer shown first and an older one of another arriving after.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const ask = (id, asker, minutes) => ({ board: 'team-a', kind: 'ask', id, asker, text: 'Q-' + asker + '-end', at: new Date(Date.now() - minutes * 60000).toISOString() });
    const order = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(r => (/Q-(\\w+)-end/.exec(r.textContent) || [])[1]).filter(Boolean)`);
    const refresh = () => ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`).then(() => ev(framesJs(10)));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`window.__asks = ${JSON.stringify([ask(1, 'Alpha', 10), ask(2, 'Bravo', 5)])};
                (() => { const original = window.fetch; window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin); if (u.pathname === '/api/operator-asks') return Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })); return original(url, opts); }; return true; })()`);
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = []; m.updateInboxTab(); return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await refresh();
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 2`, 'the two questions', 15000);
            const first = await order();
            assert.deepEqual([...first].sort(), ['Alpha', 'Bravo'], at + 'the two questions are shown: ' + JSON.stringify(first));

            await ev(`window.__asks.push(${JSON.stringify(ask(3, 'Charlie', 1))}); true`); // a computer that answered late, with a question newer than the two shown (the default sort puts the newest first, so before this change it jumped to the top)
            await refresh();
            assert.deepEqual(await order(), [...first, 'Charlie'], at + 'the late question goes after the rows on screen, it does not move them');

            const gone = first[0]; // one is answered: the rest keep their order
            await ev(`window.__asks = window.__asks.filter(a => a.asker !== ${JSON.stringify(gone)}); true`);
            await refresh();
            assert.deepEqual(await order(), [first[1], 'Charlie'], at + 'an answered row leaves, the others stay in order');

            await ev(`(async () => { const m = await import(${S} + 'inbox_tab.js'); m.selectInboxTab('tasks'); await new Promise(r => setTimeout(r, 50)); m.selectInboxTab('needs'); return true; })()`);
            await ev(`window.__asks.push(${JSON.stringify(ask(4, 'Delta', 0.5))}); true`);
            await refresh();
            assert.deepEqual(await order(), [first[1], 'Charlie', 'Delta'], at + 'switching folders keeps what the person saw too, until a filter changes');

            // a column sort the person chose is kept the same way: Item ascending, then a late computer's row that sorts first goes after the rows shown (the table used to sort the whole list again)
            await ev(`(() => { const th = document.querySelector('${T} thead th[data-key=agent]'); (th.querySelector('button') || th).click(); return true; })()`);
            await ev(framesJs(6));
            const sorted = await order();
            assert.deepEqual(sorted, [...sorted].sort(), at + 'Item ascending sorts the rows shown: ' + JSON.stringify(sorted));
            await ev(`window.__asks.push(${JSON.stringify(ask(5, 'Aardvark', 2))}); true`);
            await refresh();
            assert.deepEqual(await order(), [...sorted, 'Aardvark'], at + 'under a column sort a late row sorting first still goes after the rows on screen');

            // a row under the pointer never moves: hold the mouse down on a row, a late older row arrives, the row is where it was
            const target = await ev(`(() => { const row = [...document.querySelectorAll('${T} tbody tr')].find(t => /Q-(\\w+)-end/.exec(t.textContent)[1] === ${JSON.stringify(sorted[1])}); const b = row.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), top: Math.round(b.top) }; })()`);
            await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
            await ev(`window.__asks.push(${JSON.stringify(ask(6, 'Aaron', 90))}); true`);
            await refresh();
            const held = await ev(`(() => { const row = [...document.querySelectorAll('${T} tbody tr')].find(t => /Q-(\\w+)-end/.exec(t.textContent)[1] === ${JSON.stringify(sorted[1])}); return Math.round(row.getBoundingClientRect().top); })()`);
            await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
            assert.equal(held, target.top, at + 'the row under the held pointer did not move when a late row arrived');
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS Needs you keeps its order when a computer answers late');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
