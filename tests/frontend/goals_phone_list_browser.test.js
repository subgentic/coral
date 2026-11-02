// A phone's Goals list on the team page (#12230, the operator): rows go edge to edge like the chat (no bordered card around the table), the toolbar is one line (the search, the filter folded into one icon, a compact "New goal"
// button), there is no Select button and no row checkbox, and a long press selects a row, as in Needs you. A desktop keeps its table, its Select button and its "New goal" text button. Real goals on the isolated server,
// 390 and 430 px as touch, 1280 as a mouse. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'goalsphone-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const P = '#team-panel-goals';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B });
        for (const t of ['Ship the pilot', 'Fix the phone Goals list', 'Write the docs']) check((await api('POST', '/goals', { subscriber_id: 'Operator', title: t, outcome: 'The outcome of ' + t + ' in one line, which is long enough to be cut on a phone.', done_when: 'it is done' })).status === 201, 'made goal ' + t);
        const setReq = await api('PUT', '/settings', { subscriber_id: 'Operator', require_goal: true }); check(setReq.status < 300, 'the board requires a goal: ' + setReq.status);
        for (const [w, mobile] of [[390, true], [430, true], [1280, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/team/' + B + '/goals' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await waitFor(`document.querySelectorAll('${P} tbody tr').length >= 3`, at + 'the goal rows', 15000);
            await ev(framesJs(6));
            const m = await ev(`(() => { const t = document.querySelector('${P}'), box = t.querySelector('.dt-box'), r = e => e.getBoundingClientRect(), vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
                const bar = t.querySelector('.team-toolbar-row'), search = bar.querySelector('.list-bar-search-wrap'), select = bar.querySelector('.team-tb-select'), add = bar.querySelector('.goals-new');
                return { boxLeft: Math.round(r(box).left), boxW: Math.round(r(box).width), vw: innerWidth, radius: getComputedStyle(box).borderTopLeftRadius, sideBorder: getComputedStyle(box).borderLeftWidth,
                    checks: [...t.querySelectorAll('input[type=checkbox]')].filter(vis).length, selectBtn: [...t.querySelectorAll('button')].filter(b => vis(b) && /^Select$/.test(b.textContent.trim())).length,
                    tops: [search, select, add].map(e => Math.round(r(e).top)), addW: Math.round(r(add).width), addLabel: add.getAttribute('aria-label'), addText: add.textContent.trim(), selectVisible: vis(select), pillsVisible: !![...bar.querySelectorAll('.team-tb-pills')].some(vis), rows: t.querySelectorAll('tbody tr').length }; })()`);
            if (mobile) {
                check(m.boxLeft === 0 && m.boxW === m.vw, at + 'the rows go edge to edge, no card: ' + JSON.stringify(m));
                check(m.radius === '0px' && m.sideBorder === '0px', at + 'no rounded or side-bordered box: ' + JSON.stringify([m.radius, m.sideBorder]));
                check(m.checks === 0 && m.selectBtn === 0, at + 'no row checkboxes and no Select button: ' + JSON.stringify([m.checks, m.selectBtn]));
                check(new Set(m.tops).size === 1, at + 'the search, the filter and New goal are one line: ' + JSON.stringify(m.tops));
                check(m.addW <= 48 && m.addLabel === 'New goal' && m.addText !== 'New goal', at + 'New goal is a compact icon button with its name: ' + JSON.stringify([m.addW, m.addLabel, m.addText]));
                const two = await ev(`(() => { const r = document.querySelector('${P} tbody tr'); const ask = r.querySelector('.dt-mail-ask'), title = r.querySelector('.dt-mail-title'), side = r.querySelector('.dt-mail-time'); return { ask: ask ? ask.textContent : null, title: title.textContent, side: side.textContent, stacked: !!ask && ask.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 2 }; })()`);
                check(!!two.ask && two.stacked && /^The outcome of /.test(two.ask), at + 'a row is two lines: the goal, then its one-line outcome: ' + JSON.stringify(two));
                check(/^Active/.test(two.side), at + 'and the state (and the task count, when it has tasks) is on the right: ' + JSON.stringify(two.side));
                const note = await ev(`(() => { const n = document.querySelector('${P} .goals-require'); return n ? { text: n.textContent.trim(), title: n.title, h: Math.round(n.getBoundingClientRect().height) } : null; })()`);
                check(!!note && /^info\s*Goal required here$/.test(note.text) && /refused on this board/.test(note.title) && note.h <= 24, at + 'the notice is one quiet line, the sentence on its tooltip: ' + JSON.stringify(note));
                check(m.selectVisible && !m.pillsVisible, at + 'the filter is folded into one control: ' + JSON.stringify([m.selectVisible, m.pillsVisible]));
                // a tap opens the goal (the same open as before the redesign: a programmatic click on the row's button too)
                const tapAt = await ev(`(() => { const r = document.querySelector('${P} tbody tr .dt-mail-title').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
                for (const type of ['touchStart', 'touchEnd']) { await client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: tapAt.x, y: tapAt.y, id: 1 }] }); await new Promise(r => setTimeout(r, 60)); } // sleep-ok: a tap is a short touch
                const tapped = await waitFor(`!!document.querySelector('.goals-page .goals-back, #team-panel-item .goals-back, .goal-page .goals-back')`, at + 'a tap opens the goal', 5000).then(() => true, () => false);
                check(tapped, at + 'a tap on a goal opens its page');
                await ev(`document.querySelector('.goals-back')?.click(); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the list draws again
                await waitFor(`document.querySelectorAll('${P} tbody tr').length >= 3`, at + 'back on the list', 8000);
                const clicked = await ev(`(() => { document.querySelector('${P} tbody tr .dt-primary').click(); return true; })()`);
                const viaClick = await waitFor(`!!document.querySelector('.goals-page .goals-back, #team-panel-item .goals-back, .goal-page .goals-back')`, at + 'a click opens the goal', 5000).then(() => true, () => false);
                check(viaClick, at + 'a click on the row\'s button opens the goal too (what the way-back suites do)');
                await Page.navigate({ url: BASE + '/team/' + B + '/goals' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await waitFor(`document.querySelectorAll('${P} tbody tr').length >= 3`, at + 'the goal rows again', 15000);
                // a long press selects a row; its bar says so
                const at1 = await ev(`(() => { const r = document.querySelector('${P} tbody tr .dt-mail-title').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`); // on the goal's own title: the button that opens the row
                const t = type => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: at1.x, y: at1.y, id: 1 }] });
                await t('touchStart'); await new Promise(r => setTimeout(r, 700)); await t('touchEnd'); // sleep-ok: a long press is a held finger
                await waitFor(`/1 selected/.test(document.querySelector('${P} .dt-bar')?.textContent || '')`, at + 'a long press selects the row', 5000).catch(() => check(false, at + 'a long press selects the row (no "1 selected" bar)'));
            } else {
                check(m.checks >= 3, at + 'a desktop keeps its row checkboxes: ' + m.checks);
                check(m.addText === 'New goal', at + 'and its "New goal" button: ' + m.addText);
                check(m.boxLeft > 0, at + 'and its table box inside the page: ' + m.boxLeft);
            }
        }
        // the Inbox's Goals folder on a phone (#12230): the same two-line rows, and a long press selects (a bar with Close goals), as in Needs you
        for (const [w] of [[390], [430]]) {
            const at = `Inbox ${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 3`, at + 'the goal rows', 15000);
            await ev(framesJs(6));
            const g = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr'), ask = r.querySelector('.dt-mail-ask'), title = r.querySelector('.dt-mail-title'); return { ask: ask ? ask.textContent : null, stacked: !!ask && ask.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 2, side: r.querySelector('.dt-mail-time').textContent }; })()`);
            check(!!g.ask && g.stacked && /^The outcome of /.test(g.ask), at + 'a row is two lines, the goal then its outcome: ' + JSON.stringify(g));
            check(/^Active/.test(g.side), at + 'with the state on the right: ' + g.side);
            const at2 = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr .dt-mail-title').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
            const tt = type => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: at2.x, y: at2.y, id: 1 }] });
            await tt('touchStart'); await new Promise(r => setTimeout(r, 700)); await tt('touchEnd'); // sleep-ok: a long press is a held finger
            await waitFor(`/1 selected/.test(document.querySelector('#group-table-view .gt-toolbar')?.textContent || document.querySelector('.dt-bar')?.textContent || '')`, at + 'a long press selects the goal', 5000).catch(() => check(false, at + 'a long press selects the goal (no "1 selected" bar); the page is on ' + location.pathname));
            check(!(await ev(`location.pathname`)).includes('/goals/'), at + 'and does not open it');
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('goals_phone_list_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
