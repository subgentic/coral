// Needs you keeps the order the person is looking at when a computer answers late (#12636, coral-hub's beta pass, finding 3): the Hub shows this computer's rows at once, then each registered computer's questions
// arrive over the next seconds, and the list was re-sorted by waiting time every time, so rows moved under a finger about to tap one. Now a row already shown stays where it is, a row that is new (even an older one)
// goes after them (the default sort puts the newest first, so a new one used to jump to the top), and a different search, filter or sort starts the order afresh. At 1280 and 390 px (a coarse pointer at 390), with the questions of one computer shown first and an older one of another arriving after.
// #22094: the list is the Needs you ledger (needs_ledger.js): each question is an article.nl-row in the 'Not tied to a goal' group (open, it holds questions). The ledger lists every row newest first on each draw
// (its documented order), so a late computer's row now takes its time place too, as this computer's do; what still never moves is the row under a held pointer (the redraw waits for the release).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const ask = (id, asker, minutes, server) => ({ ...(server ? { server } : {}), board: 'team-a', kind: 'ask', id, asker, text: 'Q-' + asker + '-end', at: new Date(Date.now() - minutes * 60000).toISOString() });
    const order = () => ev(`[...document.querySelectorAll('${T} .nl-row')].map(r => (/Q-(\\w+)-end/.exec(r.textContent) || [])[1]).filter(Boolean)`);
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
            await waitFor(`document.querySelectorAll('${T} .nl-row').length >= 2`, 'the two questions', 15000);
            let first = await order();
            assert.deepEqual([...first].sort(), ['Alpha', 'Bravo'], at + 'the two questions are shown: ' + JSON.stringify(first));

            await ev(`window.__asks.push(${JSON.stringify(ask(6, 'Foxtrot', 7))}); true`); // a question from this computer that slots in between the two shown: it goes in at its sorted place, newest first (walk #20067 row 6)
            await refresh();
            assert.deepEqual(await order(), [first[0], 'Foxtrot', first[1]], at + 'a question from this computer slots in newest first: ' + JSON.stringify(await order()));
            first = await order();
            for (const [id, name, minutes] of [[11, 'Golf', 8], [12, 'Hotel', 6.5], [13, 'India', 9]]) { await ev(`window.__asks.push(${JSON.stringify(ask(id, name, minutes))}); true`); await refresh(); } // a burst of questions from this computer over several redraws (walk #20067 row 6)
            assert.deepEqual(await order(), [first[0], 'Hotel', 'Foxtrot', 'Golf', 'India', first[2]], at + 'a burst of local questions reads newest first, not in runs: ' + JSON.stringify(await order()));
            await ev(`window.__asks = window.__asks.filter(a => !['Golf', 'Hotel', 'India'].includes(a.asker)); true`);
            await refresh();
            assert.deepEqual(await order(), first, at + 'the burst answered, the first rows are as they were');
            await ev(`window.__asks.push(${JSON.stringify(ask(3, 'Charlie', 7.5, 'box-2'))}); true`); // ANOTHER computer that answered late, with a question between the rows shown
            await refresh();
            assert.deepEqual(await order(), [first[0], first[1], 'Charlie', first[2]], at + 'the late question from another computer takes its time place, newest first (the ledger\'s order; it went after the rows shown, #12636)');
            await ev(`window.__asks.push(${JSON.stringify(ask(7, 'Delta', 0.5))}); true`); // a question newer than everything on screen is the freshest arrival: on top, and visible
            await refresh();
            assert.deepEqual(await order(), ['Delta', first[0], first[1], 'Charlie', first[2]], at + 'a question newer than everything shown goes on top');

            const gone = first[0]; // one is answered: the rest keep their order
            await ev(`window.__asks = window.__asks.filter(a => a.asker !== ${JSON.stringify(gone)}); true`);
            await refresh();
            assert.deepEqual(await order(), ['Delta', first[1], 'Charlie', first[2]], at + 'an answered row leaves, the others stay in order');

            await ev(`(async () => { const m = await import(${S} + 'inbox_tab.js'); m.selectInboxTab('tasks'); await new Promise(r => setTimeout(r, 50)); m.selectInboxTab('needs'); return true; })()`);
            await ev(`window.__asks.push(${JSON.stringify(ask(4, 'Echo', 60, 'box-2'))}); true`);
            await refresh();
            assert.deepEqual(await order(), ['Delta', first[1], 'Charlie', first[2], 'Echo'], at + 'switching folders and back, then an older late row: newest first, the older one last');

            // the column-sort check (Item ascending, then a late row after the rows shown) is retired: the ledger has no column headers or sort (#22094, removed by design; its order is newest first, needs_ledger_browser 'flat rows keep strict time order')
            const sorted = await order();

            // the page's own click on a row opens its question: the held presses below are counted and swallowed here, so the table stays in view
            await ev(`window.__clicks = []; document.addEventListener('click', e => { const row = e.target.closest && e.target.closest('${T} .nl-row'); if (!row) return; window.__clicks.push({ connected: e.target.isConnected && document.contains(row), row: (/Q-(\\w+)-end/.exec(row.textContent) || [])[1] }); e.stopImmediatePropagation(); e.preventDefault(); }, true); true`);
            // a row under the pointer never moves: hold the mouse down on a row, a late row newer than all (the ledger would draw it on top) arrives, the row is where it was
            const place = () => ev(`(() => { const row = [...document.querySelectorAll('${T} .nl-row')].find(t => /Q-(\\w+)-end/.exec(t.textContent)[1] === ${JSON.stringify(sorted[1])}); const b = row.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), top: Math.round(b.top) }; })()`);
            let target = await place();
            await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
            await ev(`window.__asks.push(${JSON.stringify(ask(9, 'Aaron', 0.2, 'box-2'))}); true`);
            await refresh();
            const held = await ev(`(() => { const row = [...document.querySelectorAll('${T} .nl-row')].find(t => /Q-(\\w+)-end/.exec(t.textContent)[1] === ${JSON.stringify(sorted[1])}); return Math.round(row.getBoundingClientRect().top); })()`);
            await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
            assert.equal(held, target.top, at + 'the row under the held pointer did not move when a late row arrived');
            await waitFor(`/Q-Aaron-end/.test(document.querySelector('${T} .nl-row')?.textContent || '')`, 'the newer late row drawn on top once the pointer is up', 10000);
            target = await place(); // it moved the held row down one place, after the release

            // and when a row ABOVE it is answered elsewhere while the pointer is held: it stays on screen until the pointer goes up, then it goes
            await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
            await ev(`window.__asks = window.__asks.filter(a => !(new RegExp('Q-' + ${JSON.stringify(sorted[0])} + '-end')).test(a.text)); true`);
            await refresh();
            const heldNames = await order();
            const heldTop = await ev(`(() => { const row = [...document.querySelectorAll('${T} .nl-row')].find(t => /Q-(\\w+)-end/.exec(t.textContent)[1] === ${JSON.stringify(sorted[1])}); return Math.round(row.getBoundingClientRect().top); })()`);
            await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
            assert.equal(heldTop, target.top, at + 'a row above the held one was answered elsewhere: the held row did not move up: ' + JSON.stringify({ heldTop, target, heldNames, sorted }));
            assert.ok(heldNames.includes(sorted[0]), at + 'the answered row stays until the pointer is released: ' + JSON.stringify(heldNames));
            await waitFor(`!${JSON.stringify(sorted[0])} || ![...document.querySelectorAll('${T} .nl-row')].some(t => t.textContent.includes('Q-' + ${JSON.stringify(sorted[0])} + '-end'))`, 'the answered row goes once the pointer is up', 10000);

            // a press on a row, a row elsewhere answered during the hold, release: the click reaches the row that was pressed, once, still in the page (the redraw waits until the click is done)
            const pick = await ev(`(() => { const names = [...document.querySelectorAll('${T} .nl-row')].map(t => (/Q-(\\w+)-end/.exec(t.textContent) || [])[1]); const row = [...document.querySelectorAll('${T} .nl-row')].find(t => (/Q-(\\w+)-end/.exec(t.textContent) || [])[1] === names[names.length - 1]); row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect(); return { name: names[names.length - 1], first: names[0], x: Math.round(Math.max(r.left, 0) + 120), y: Math.round(r.top + r.height / 2) }; })()`);
            await ev(`window.__clicks = []; true`);
            await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: pick.x, y: pick.y, button: 'left', clickCount: 1 });
            await ev(`window.__asks = window.__asks.filter(a => !(new RegExp('Q-' + ${JSON.stringify(pick.first)} + '-end')).test(a.text)); true`);
            await refresh();
            await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: pick.x, y: pick.y, button: 'left', clickCount: 1 });
            await waitFor(`window.__clicks.length >= 1`, 'the click on the pressed row', 5000);
            await ev(framesJs(10));
            const clicks = await ev(`window.__clicks`);
            assert.deepEqual(clicks, [{ connected: true, row: pick.name }], at + 'the pressed row got its click, once, while it was still in the page: ' + JSON.stringify(clicks));
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS Needs you keeps its order when a computer answers late');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
