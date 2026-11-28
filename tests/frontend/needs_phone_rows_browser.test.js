// #11671 (the operator, Gmail-style rows on a phone), on the Needs you list (article.nl-row, #22094, the approved ledger): a phone's row carries only its own controls (a file's name button, a question's answers, More), every one a 44 px
// target; a tap opens it; Select in the phone title bar (#top-phone-bar .nl-phone-select) shows each row's check, a check adds the row, and the selection bar (.nl-summary: "N selected", Dismiss, Mark as read, Clear) acts on it,
// one request per item through the same routes as a row's own buttons, one toast with Undo; a selection that does not fit an action turns it off. Review and question rows at 390 and 360 px and a phone-sized window whose
// pointer is not coarse, real touch through CDP. Retired with the old table (#22094, by design): the long press and the swipe (selection is Select and the check; a file's Dismiss is the bar's; welcome_swipe_browser keeps
// the welcome swipe), Goal and Task chips in a row (the goal is the row's group heading), and the bar's Approve, Save for later, Changes and Mark unread with Approve's confirm (review decisions stay in the file viewer).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch } = client, { safePaused } = require('./helpers/paused');
    const team = 'phone-rows-' + Date.now().toString(36);
    const T = '#group-table-view .needs-ledger'; const late = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // [width, touch emulation]: the third pass is a phone-sized window whose pointer is not reported coarse (a driver that sets only the screen size, #11765): a swipe must work there too
        for (const [w, touchEmu] of [[390, true], [360, true], [390, false]]) {
            const at = `${w} px${touchEmu ? '' : ', pointer not coarse'}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: touchEmu });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await Fetch.enable({ patterns: [{ urlPattern: '*/menu_button.js*', requestStage: 'Request' }] }); // a cold, slow phone: the menu's module answers 1.5 s late (what a 2-core runner does to the first tap, v2.0.24)
            safePaused(client, e => setTimeout(() => Fetch.continueRequest({ requestId: e.requestId }).catch(() => {}), 1500));
            assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
            await ev(`(() => {
                const mk = n => ({ id: n.toString(16).padStart(64, '0'), name: 'Phone review ' + n + '.txt', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - n) * 60000).toISOString(), tags: ['for review'], available: true, uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0'), produced_by: 'Review Writer', session_id: 'rw-1', task_id: n, goal_id: 77, goal_title: 'Phone selection' });
                window.__reviewItems = [mk(1), mk(2), mk(3), mk(4), mk(5)]; window.__asks = [{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which port should the test server use?', at: '2026-10-31T01:00:00Z' }];
                window.__calls = []; const original = window.fetch.bind(window), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const pageURL = new URL(String(u), location.href), page = pageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(pageURL, location.href, {'${team}': window.__reviewItems}) : null; if (page) return json(page); const url = String(u), x = window.__reviewFixtureURL(url, location.origin), method = o.method || 'GET';
                    if (x.pathname.endsWith('/review-drafts')) return json({drafts_supported:false,drafts:[],count:0,revision:0,can_write:false,can_send:false});
                    if (x.pathname === '/api/board/${team}/artifacts') { const items = window.__reviewItems.filter(a => !x.searchParams.has('tag') || a.tags.includes(x.searchParams.get('tag'))); return json({ project: '${team}', artifacts: items, has_more: false }); }
                    const rv = x.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts\\/([0-9a-f]+)\\/review$/);
                    if (rv && method === 'POST') { const body = JSON.parse(o.body); window.__calls.push({ review: rv[1], decision: body.decision }); if (['approve', 'ignore', 'save'].includes(body.decision)) window.__reviewItems = window.__reviewItems.filter(a => a.id !== rv[1]); return json({ ok: true }); }
                    if (x.pathname === '/api/settings' && method === 'PUT') { window.__puts = window.__puts || []; window.__puts.push(o.body ? JSON.parse(o.body) : {}); return json({ ok: true }); } // the welcome items complete themselves by detection and save that: nothing is written to the server's settings (the gate's --fail-on-leak)
                    if (url === '/api/operator-asks') return json(window.__asks);
                    const m = url.match(/\\/api\\/board\\/${team}\\/asks\\/(\\d+)\\/close$/);
                    if (m && method === 'POST') { const body = JSON.parse(o.body); window.__calls.push({ ask: Number(m[1]), undo: !!body.undo }); if (!body.undo) window.__asks = window.__asks.filter(a => a.id !== Number(m[1])); return json({ ok: true, closed_by: 'Operator' }); }
                    return original(u, o); };
                return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.settings = { ...m.state.settings, inbox_welcome: 'off', inbox_welcome_done: '' }; return true; })`); // #18764: Getting started items are ordinary, counted rows now (inbox_welcome_counts_browser); off here, the suite is about review and question rows
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .nl-row').length === 6`, at + 'six counted review/question rows', 15000);
            await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`); // a goal group starts folded unless it holds a question: the five files' goal is opened
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the list settles after its first draw

            assert.equal(await ev(`(document.querySelector('#group-table-view .view-list-nav')?.getClientRects().length || 0)`), 0, at + 'row actions remain usable without the Inbox strip');
            assert.equal(await ev(`(n => n && n.getClientRects().length ? n.textContent : '')(document.querySelector('#top-phone-bar .nl-phone-title'))`), 'Needs you', at + 'the current folder name stays visible');

            const rowOf = name => `[...document.querySelectorAll('${T} .nl-row')].find(r => r.textContent.includes(${JSON.stringify(name)}))`;
            const touch = (type, p) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }] });
            // a tap must start on a settled list: no row added, removed or redrawn for 250 ms (a late Inbox read redraws it on a loaded runner), scrolled to at once (a smooth scroll moves the row under the finger)
            const settled = () => ev(`new Promise(done => { const root = document.querySelector('#group-table-view'), t0 = Date.now(); let last = Date.now(); const mo = new MutationObserver(() => { last = Date.now(); }); mo.observe(root, { childList: true, subtree: true, characterData: true }); const tick = () => { if (Date.now() - last > 250 || Date.now() - t0 > 8000) { mo.disconnect(); done(true); } else setTimeout(tick, 50); }; tick(); })`);
            const tapAt = async (js, edge) => { await settled(); const p = await ev(`(() => { const node = ${js}; node.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = node.getBoundingClientRect(), row = node.closest('.nl-row'); return { x: ${edge ? 'row.getBoundingClientRect().left + 6' : 'r.left + r.width / 2'}, y: r.top + Math.min(r.height / 2, 10) }; })()`); await touch('touchStart', p); await new Promise(r => setTimeout(r, 60)); await touch('touchEnd', p); await new Promise(r => setTimeout(r, 300)); }; // sleep-ok: a tap, and the list redraws
            const check = name => tapAt(`${rowOf(name)}.querySelector('.nl-check')`);
            const bar = () => ev(`(() => { const b = document.querySelector('${T} .nl-summary'); if (!b || !b.getClientRects().length || !/selected/.test(b.textContent)) return null; const r = b.getBoundingClientRect(), btns = [...b.querySelectorAll('button')].filter(x => x.getClientRects().length), tops = btns.map(x => Math.round(x.getBoundingClientRect().top)); return { count: (b.querySelector('strong') || {}).textContent, h: Math.round(r.height), oneLine: Math.max(...tops) - Math.min(...tops) <= 4, small: btns.filter(x => x.getBoundingClientRect().width < 43.5 || x.getBoundingClientRect().height < 43.5).map(x => x.textContent), actions: btns.map(x => ({ label: x.getAttribute('aria-label') || x.textContent, off: x.disabled })) }; })()`);
            const pressBar = label => ev(`[...document.querySelectorAll('${T} .nl-summary button')].find(x => (x.getAttribute('aria-label') || x.textContent) === ${JSON.stringify(label)}).click(); true`);
            const selected = () => ev(`[...document.querySelectorAll('${T} .nl-row.nl-is-selected')].map(r => r.textContent.slice(0, 60))`);
            const startSelect = async () => { await tapAt(`document.querySelector('#top-phone-bar .nl-phone-select')`); assert.ok(await ev(`[...document.querySelectorAll('${T} .nl-row .nl-check')].every(c => c.getClientRects().length > 0)`), at + 'Select shows every row\'s check'); };

            // a phone row carries only its own controls, each a 44 px target (the file's name opens it, the question's answers, More)
            const visible = await ev(`[...document.querySelectorAll('${T} .nl-row button, ${T} .nl-row summary')].filter(b => { const c = b.getBoundingClientRect(); return b.getClientRects().length > 0 && c.width > 2 && c.height > 2 && getComputedStyle(b).visibility !== 'hidden' && !b.closest('details.nl-more:not([open]) .nl-menu'); }).map(b => ({ label: b.getAttribute('aria-label') || b.textContent, own: b.matches('.nl-file-open, .nl-actions button, .nl-more-toggle'), small: b.getBoundingClientRect().height < 43.5 }))`);
            assert.deepEqual(visible.filter(b => !b.own || b.small), [], at + 'a phone row carries navigation and its own buttons only, each 44 px tall: ' + JSON.stringify(visible));
            assert.equal(await ev(`document.querySelectorAll('${T} .nl-row [data-goal-pill], ${T} .nl-row [data-task-pill]').length`), 0, at + 'no Goal or Task chip in a row: the goal is its group heading');
            // the question's More opens on the first tap, at once, even with menu_button.js 1.5 s late (v2.0.24: the press reached nothing on a cold runner)
            await tapAt(`${rowOf('Which port should the test server use?')}.querySelector('.nl-more-toggle')`);
            await waitFor(`!!${rowOf('Which port should the test server use?')}.querySelector('details.nl-more[open] .nl-menu .menu-item')`, at + 'the first tap on More opens its menu at once', 600);
            assert.deepEqual(await ev(`[...${rowOf('Which port should the test server use?')}.querySelectorAll('.nl-menu .menu-item')].map(b => [b.textContent, b.getBoundingClientRect().height >= 43.5])`), [['Open question', true], ['Dismiss', true]], at + 'the question\'s More holds Open question and Dismiss, 44 px each');
            await ev(`${rowOf('Which port should the test server use?')}.querySelector('details.nl-more').open = false; true`);
            // a tap opens the question
            await tapAt(`${rowOf('Which port should the test server use?')}.querySelector('.nl-title')`, true); // the row's left padding beside its title's first line, clear of the meta line's links that a finger's touch adjustment reaches (#20308)
            await waitFor(`!!document.querySelector('dialog[open]')`, at + 'a tap opens the question', 6000);
            await ev(`document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })); const d = document.querySelector('dialog[open]'); if (d) d.close(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog closes
            assert.equal(await bar(), null, at + 'no selection bar before a selection');
            await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`);
            const endGap = () => ev(`(() => { const sc = document.getElementById('group-table-view'), l = document.querySelector('${T}'); return Math.round(sc.scrollHeight - (l.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop)); })()`);
            const gap0 = await endGap();
            // five folder switches, then ONE Dismiss of one file is ONE request and ONE toast (listeners added again with every list build must not stack, QA Reviewer 2's MUST)
            for (let i = 0; i < 5; i++) {
                await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`); await new Promise(r => setTimeout(r, 150)); // sleep-ok: the folder draws
                await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await new Promise(r => setTimeout(r, 250)); // sleep-ok: the folder draws
            }
            await waitFor(`!!(${rowOf('Phone review 5.txt')})`, at + 'Needs you is back after the folder switches', 8000);
            await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`);
            await ev('window.__calls = []; true');
            await startSelect(); await check('Phone review 5.txt');
            assert.equal((await bar() || {}).count, '1 selected', at + 'one file selected');
            await pressBar('Dismiss');
            await waitFor(`window.__calls.some(c => c.review === '${(5).toString(16).padStart(64, '0')}' && c.decision === 'ignore')`, at + 'Dismiss ignores the review file', 6000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: a stacked listener would send its second request meanwhile
            assert.equal(await ev(`window.__calls.filter(c => c.review === '${(5).toString(16).padStart(64, '0')}' && c.decision === 'ignore').length`), 1, at + 'after the folder switches one Dismiss is one ignore request');
            assert.equal(await ev(`[...document.querySelectorAll('.toast')].filter(t => /Dismissed 1/.test(t.textContent)).length`), 1, at + 'and one toast');
            await waitFor(`!${rowOf('Phone review 5.txt')}`, at + 'and its row is gone', 6000);
            await ev('window.__calls = []; true');
            // Select, then a check selects a review file and only it; the bar shows what fits
            await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`);
            if (!(await ev(`!!document.querySelector('${T}.nl-selection-active')`))) await startSelect();
            await check('Phone review 1.txt');
            { const sel = await selected(); assert.ok(sel.length === 1 && sel[0].includes('Phone review 1.txt'), at + 'the check selects that row and only it: ' + JSON.stringify(sel)); }
            assert.equal(await ev(`!!document.querySelector('dialog[open]')`), false, at + 'a check opens nothing');
            let b = await bar();
            assert.ok(b && b.count === '1 selected', at + 'the bar says 1 selected: ' + JSON.stringify(b));
            assert.deepEqual(b.actions.map(a => a.label), ['Dismiss', 'Mark as read', 'Clear'], at + 'the bar: Dismiss, Mark as read and Clear (#22094): ' + JSON.stringify(b.actions));
            if (!(b.oneLine && b.h <= 64 && b.small.length === 0)) late.push(at + 'the bar is one line, every target 44 px, each named (Gmail, #11707): ' + JSON.stringify({ h: b.h, oneLine: b.oneLine, small: b.small }));
            // the bar is the top row of the list and stays there while the list scrolls (the operator, comment 28; #11707)
            const stay = await ev(`(() => { const bar = document.querySelector('${T} .nl-summary'), sc = document.getElementById('group-table-view'); sc.scrollTop = sc.scrollTop + 500; const r = bar.getBoundingClientRect(), t = sc.getBoundingClientRect(); return { top: Math.round(r.top - t.top), shown: r.height > 0 }; })()`);
            if (!(stay.shown && stay.top >= -1 && stay.top <= 40)) late.push(at + 'after the list scrolls the bar is still at the top of the screen (within 40 px of the list top): ' + JSON.stringify(stay)); // the bar's layout is said at the end, so the rest of each pass still runs
            await ev(`document.getElementById('group-table-view').scrollTop = 0; true`);
            // the empty area under the list at its end is the same with rows selected as without: a selection adds none (#11765)
            const gap1 = await endGap();
            assert.ok(Math.abs(gap1 - gap0) <= 2, at + 'under the last row a selection adds no empty area: ' + JSON.stringify({ without: gap0, with: gap1 }));
            assert.ok(!b.actions.find(a => a.label === 'Dismiss').off, at + 'a file can be dismissed');
            // a check adds the question; a question with files: only what fits both
            await check('Which port should the test server use?');
            b = await bar(); assert.equal(b.count, '2 selected', at + 'a check adds a row: ' + JSON.stringify(b)); assert.equal(await ev(`!document.querySelector('dialog[open]')`), true, at + 'and opens nothing');
            const has = l => b.actions.some(x => x.label === l); assert.ok(!has('Approve') && !has('Changes') && !has('Save for later') && has('Dismiss') && !b.actions.find(a => a.label === 'Dismiss').off, at + 'a question with files in the selection: the bar offers no review action (#15120), only Dismiss: ' + JSON.stringify(b.actions));
            // Dismiss both: one request each, one toast with Undo, then Undo puts both back
            await pressBar('Dismiss');
            await waitFor(`window.__calls.some(c => c.ask === 71 && !c.undo) && window.__calls.some(c => c.review && c.decision === 'ignore')`, at + 'one request per item', 8000);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed 2/.test(t.textContent) && [...t.querySelectorAll('button')].some(x => x.textContent.trim() === 'Undo'))`, at + 'one toast with Undo', 8000);
            assert.equal(await bar(), null, at + 'the selection is over');
            await ev(`[...document.querySelectorAll('.toast')].find(t => /Dismissed 2/.test(t.textContent)).querySelectorAll('button').forEach(x => { if (x.textContent.trim() === 'Undo') x.click(); }); true`);
            await waitFor(`window.__calls.some(c => c.ask === 71 && c.undo) && window.__calls.some(c => c.review && c.decision === 'unignore')`, at + 'Undo is one request per item too', 8000);
            // Clear leaves the selection with nothing sent; Cancel in the title bar does too
            await waitFor(`!!(${rowOf('Phone review 2.txt')})`, at + 'the rows are back', 8000);
            await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`);
            if (!(await ev(`!!document.querySelector('${T}.nl-selection-active')`))) await startSelect();
            await check('Phone review 2.txt'); await check('Phone review 3.txt');
            b = await bar(); assert.equal(b.count, '2 selected', at + 'two files selected');
            await ev('window.__calls = []; true'); await pressBar('Clear'); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the bar leaves
            assert.equal(await bar(), null, at + 'Clear leaves selection'); assert.deepEqual(await selected(), [], at + 'nothing is selected'); assert.equal(await ev('window.__calls.length'), 0, at + 'and nothing was sent');
            await startSelect(); await check('Phone review 2.txt');
            assert.equal(await ev(`document.querySelector('#top-phone-bar .nl-phone-select').textContent`), 'Cancel', at + 'the title bar\'s Select is Cancel while selecting');
            await tapAt(`document.querySelector('#top-phone-bar .nl-phone-select')`);
            assert.equal(await bar(), null, at + 'Cancel leaves selection'); assert.deepEqual(await selected(), [], at + 'nothing is selected'); assert.equal(await ev('window.__calls.length'), 0, at + 'and nothing was sent');
            await removeBoards(ev, [team]).catch(() => {});
        }
        // Desktop nested controls retain their action even when the table has a selection.
        await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
        await Emulation.setTouchEmulationEnabled({enabled:false});
        const desktopPoint = await ev(`(async()=>{const DT=await import((window.__coralStatic||'/static/')+'data_table.js');window.__desktopSelectionActions=0;const table=DT.dataTable({label:'Desktop selection guard',rows:[{id:'one'}],rowKey:r=>r.id,fold:'always',columns:[{key:'agent',label:'Name',primary:true,line:1,cell:()=>{const b=DT.el('button','desktop-nested-action','Open task');b.addEventListener('click',()=>window.__desktopSelectionActions++);return b;}}],selectable:{longPress:true}});window.__desktopSelectionTable=table;const host=DT.el('div','inbox-needs-results');host.style.cssText='position:fixed;inset:100px 40px auto;z-index:10000;background:var(--bg-primary)';host.append(table.el);document.body.append(host);window.__desktopSelectionHost=host;table.selectButton.click();table.el.querySelector('.dt-check input').click();const button=table.el.querySelector('.desktop-nested-action');button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,width:r.width,height:r.height,target:document.elementFromPoint(x,y)?.closest('.desktop-nested-action')===button};})()`);
        assert.ok(desktopPoint.width>0 && desktopPoint.height>0 && desktopPoint.target,'desktop fixture exposes a real pointer target: '+JSON.stringify(desktopPoint));
        await client.Input.dispatchMouseEvent({type:'mousePressed',x:desktopPoint.x,y:desktopPoint.y,button:'left',clickCount:1});
        await client.Input.dispatchMouseEvent({type:'mouseReleased',x:desktopPoint.x,y:desktopPoint.y,button:'left',clickCount:1});
        await waitFor(`window.__desktopSelectionActions === 1`,'desktop pointer still reaches its nested action while selected',3000);
        assert.equal(await ev(`window.__desktopSelectionTable.selection().size`),1,'desktop action preserves selection');
        await ev(`window.__desktopSelectionHost.remove();true`);
        assert.deepEqual(late, [], 'the selection bar: one line of 44 px targets that stays in view');
        console.log('\nPASS the phone rows: only their own 44 px controls, tap opens, Select and a check select, the bar acts on the selection');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
