// #11671 (the operator, Gmail-style rows on a phone; it replaces #11642's per-row button there): a phone's Needs you row carries no button. A tap opens it, a long press selects it (a check appears, a tap adds more),
// a swipe to the left ignores it (with Undo), and a bar that takes the toolbar's line acts on the selection: Approve, Changes, Ignore, Save for later, Mark read or unread, Cancel, one request per item through the same
// routes as a row's own buttons. A selection that does not fit an action turns it off (a question cannot be approved, Changes is for one file). Welcome, review and question rows at 390 and 360 px, real touch through CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'phone-rows-' + Date.now().toString(36);
    const T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [390, 360]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
            await ev(`(() => {
                const mk = n => ({ id: n.toString(16).padStart(64, '0'), name: 'Phone review ' + n + '.txt', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - n) * 60000).toISOString(), tags: ['for review'], available: true, uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0'), produced_by: 'Review Writer', session_id: 'rw-1', task_id: n });
                window.__reviewItems = [mk(1), mk(2), mk(3), mk(4)]; window.__asks = [{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which port should the test server use?', at: '2026-10-31T01:00:00Z' }];
                window.__calls = []; const original = window.fetch.bind(window), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = String(u), x = new URL(url, location.origin), method = o.method || 'GET';
                    if (x.pathname === '/api/board/${team}/artifacts') { const items = window.__reviewItems.filter(a => !x.searchParams.has('tag') || a.tags.includes(x.searchParams.get('tag'))); return json({ project: '${team}', artifacts: items, has_more: false }); }
                    const rv = x.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts\\/([0-9a-f]+)\\/review$/);
                    if (rv && method === 'POST') { const body = JSON.parse(o.body); window.__calls.push({ review: rv[1], decision: body.decision }); if (['approve', 'ignore', 'save'].includes(body.decision)) window.__reviewItems = window.__reviewItems.filter(a => a.id !== rv[1]); return json({ ok: true }); }
                    if (url === '/api/operator-asks') return json(window.__asks);
                    const m = url.match(/\\/api\\/board\\/${team}\\/asks\\/(\\d+)\\/close$/);
                    if (m && method === 'POST') { const body = JSON.parse(o.body); window.__calls.push({ ask: Number(m[1]), undo: !!body.undo }); if (!body.undo) window.__asks = window.__asks.filter(a => a.id !== Number(m[1])); return json({ ok: true, closed_by: 'Operator' }); }
                    return original(u, o); };
                return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.settings = { ...m.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; return true; })`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 8`, at + 'welcome, review and question rows', 15000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the table settles after its first draw

            const rowOf = name => `[...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes(${JSON.stringify(name)}))`;
            const point = async name => ev(`(() => { const r = ${rowOf(name)}; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.left + b.width * 0.35, y: b.top + b.height * 0.35 }; })()`); // the row's own box, off its two links
            const touch = (type, p) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }] });
            const tap = async name => { const p = await point(name); await touch('touchStart', p); await new Promise(r => setTimeout(r, 60)); await touch('touchEnd', p); await new Promise(r => setTimeout(r, 250)); }; // sleep-ok: a tap, and the table redraws
            const press = async name => { const p = await point(name); await touch('touchStart', p); await new Promise(r => setTimeout(r, 700)); await touch('touchEnd', p); await new Promise(r => setTimeout(r, 300)); }; // sleep-ok: a long press is a held finger
            const bar = () => ev(`(() => { const b = document.querySelector('${T} .dt-bar, .gt-toolbar .dt-bar'); if (!b || b.hidden || !b.getClientRects().length) return null; return { count: (b.querySelector('.dt-bar-count') || {}).textContent, actions: [...b.querySelectorAll('button')].map(x => ({ label: x.textContent, off: x.disabled })) }; })()`);
            const selected = () => ev(`[...document.querySelectorAll('${T} tbody tr.dt-selected')].map(r => r.textContent.slice(0, 20))`);

            // no button is on a phone row
            const visible = await ev(`[...document.querySelectorAll('${T} tbody tr button')].filter(b => { const c = (b.closest('.dt-td') || b).getBoundingClientRect(); return c.width > 2 && c.height > 2 && getComputedStyle(b).visibility !== 'hidden'; }).map(b => b.getAttribute('aria-label') || b.textContent)`);
            assert.deepEqual(visible.filter(l => !/^(Open |Task: )/.test(l)), [], at + 'a phone row carries no action button (only its name and its task link, which open things): ' + JSON.stringify(visible));
            // a tap opens the question
            await tap('Which port should the test server use?');
            await waitFor(`!!document.querySelector('dialog[open]')`, at + 'a tap opens the question', 6000);
            await ev(`document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })); const d = document.querySelector('dialog[open]'); if (d) d.close(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog closes
            assert.equal(await bar(), null, at + 'no selection bar before a selection');
            // a long press selects a review file; a tap adds the question; the bar shows what fits
            await press('Phone review 1.txt');
            { const sel = await selected(); assert.ok(sel.length === 1 && sel[0].startsWith('Phone review 1.txt'), at + 'a long press selects that row and only it: ' + JSON.stringify(sel)); }
            let b = await bar();
            assert.ok(b && b.count === '1 selected', at + 'the bar says 1 selected: ' + JSON.stringify(b));
            assert.deepEqual(b.actions.map(a => a.label), ['Approve', 'Changes', 'Ignore', 'Save for later', 'Mark read', 'Mark unread', 'Cancel'], at + 'the actions: ' + JSON.stringify(b.actions));
            assert.ok(!b.actions.find(a => a.label === 'Approve').off && !b.actions.find(a => a.label === 'Changes').off, at + 'a file can be approved or sent back');
            await tap('Which port should the test server use?');
            b = await bar(); assert.equal(b.count, '2 selected', at + 'a tap adds a row (it does not open it): ' + JSON.stringify(b)); assert.equal(await ev(`!document.querySelector('dialog[open]')`), true, at + 'and opens nothing');
            const off = l => b.actions.find(a => a.label === l).off;
            assert.ok(off('Approve') && off('Changes') && off('Save for later') && !off('Ignore'), at + 'a question cannot be approved, sent back or saved; it can be ignored: ' + JSON.stringify(b.actions));
            // Ignore both: one request each, one toast with Undo, then Undo puts both back
            await ev(`[...document.querySelectorAll('.dt-bar button')].find(x => x.textContent === 'Ignore').click(); true`);
            await waitFor(`window.__calls.some(c => c.ask === 71 && !c.undo) && window.__calls.some(c => c.review && c.decision === 'ignore')`, at + 'one request per item', 8000);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Ignored 2/.test(t.textContent) && [...t.querySelectorAll('button')].some(x => x.textContent.trim() === 'Undo'))`, at + 'one toast with Undo', 8000);
            assert.equal(await bar(), null, at + 'the selection is over');
            await ev(`[...document.querySelectorAll('.toast')].find(t => /Ignored 2/.test(t.textContent)).querySelectorAll('button').forEach(x => { if (x.textContent.trim() === 'Undo') x.click(); }); true`);
            await waitFor(`window.__calls.some(c => c.ask === 71 && c.undo) && window.__calls.some(c => c.review && c.decision === 'unignore')`, at + 'Undo is one request per item too', 8000);
            // one file is approved directly, with no question, as a row's own button did
            await waitFor(`!!(${rowOf('Phone review 4.txt')})`, at + 'the fourth file is there', 8000);
            await press('Phone review 4.txt');
            await ev(`window.__calls = []; [...document.querySelectorAll('.dt-bar button')].find(x => x.textContent === 'Approve').click(); true`);
            await waitFor(`window.__calls.some(c => c.review === '${(4).toString(16).padStart(64, '0')}' && c.decision === 'approve')`, at + 'one file: Approve sends at once', 8000);
            // two files: Approve both; Cancel leaves with nothing sent
            await waitFor(`!!(${rowOf('Phone review 2.txt')})`, at + 'the rows are back', 8000);
            await press('Phone review 2.txt'); await tap('Phone review 3.txt');
            b = await bar(); assert.equal(b.count, '2 selected', at + 'two files selected'); assert.ok(!off('Approve') && b.actions.find(a => a.label === 'Changes').off, at + 'Changes is off for two files: ' + JSON.stringify(b.actions));
            await ev(`window.__calls = []; [...document.querySelectorAll('.dt-bar button')].find(x => x.textContent === 'Cancel').click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the bar leaves
            assert.equal(await bar(), null, at + 'Cancel leaves selection'); assert.deepEqual(await selected(), [], at + 'nothing is selected'); assert.equal(await ev('window.__calls.length'), 0, at + 'and nothing was sent');
            await press('Phone review 2.txt'); await tap('Phone review 3.txt');
            // Approve of several files asks first (Security's SHOULD): "Approve 2 files?", Keep sends nothing, the confirm sends one request per file; one file is approved directly
            await ev(`window.__calls = []; [...document.querySelectorAll('.dt-bar button')].find(x => x.textContent === 'Approve').click(); true`);
            await waitFor(`/Approve 2 files\\?/.test(document.querySelector('.dt-bar').textContent)`, at + 'it asks "Approve 2 files?"', 5000);
            assert.equal(await ev('window.__calls.length'), 0, at + 'nothing is sent while it asks');
            await ev(`document.querySelector('.dt-bar .dt-bar-keep').click(); true`); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the bar draws again
            assert.equal(await ev('window.__calls.length'), 0, at + 'Keep sends nothing');
            await ev(`[...document.querySelectorAll('.dt-bar button')].find(x => x.textContent === 'Approve').click(); true`);
            await waitFor(`/Approve 2 files\\?/.test(document.querySelector('.dt-bar').textContent)`, at + 'it asks again', 5000);
            await ev(`[...document.querySelectorAll('.dt-bar button')].filter(x => x.textContent === 'Approve').pop().click(); true`);
            await waitFor(`window.__calls.filter(c => c.review && c.decision === 'approve').length === 2`, at + 'confirming is one request per file', 8000);
            await removeBoards(ev, [team]).catch(() => {});
        }
        console.log('\nPASS the phone rows: no buttons, tap opens, long press selects, the bar acts on the selection');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
