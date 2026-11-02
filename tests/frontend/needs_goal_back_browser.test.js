// #11950 (the operator): opening a goal from Needs you ("Goal #N looks done") and pressing Back landed on the Goals tab, not Needs you. Back returns where the person came from, on a desktop and on a phone, by the page's own
// Back link and by the browser's Back (history), with the Needs you list as it was (its scroll). Real board and goals on the isolated dev server (as inbox_goal_done_browser), 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const B = 'needs-goal-back-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const dumpDbg = async tag => { try { console.log('DBG ' + tag + ' ' + JSON.stringify(await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; const gj = async p => { try { const r = await fetch(p); return await r.json(); } catch (e) { return String(e); } }; const needs = await gj('/api/needs-you?limit=50'); const goals = await gj('/api/goals'); return { now: Date.now(), iso: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, stateQuiet: (st.settings || {}).goal_done_quiet_minutes, stateRead: (st.settings || {}).goal_done_read, stateHidden: (st.settings || {}).goal_done_hidden, apiSettings: ((await gj('/api/settings')).settings || {}), needsGoalDone: (needs.items || []).filter(i => i.kind === 'goal_done'), goalsTop: Array.isArray(goals) ? goals.slice(0, 6).map(g => ({ id: g.id, board: g.board_id || g.board, looks_done_at: g.looks_done_at, status: g.status })) : goals, badge: (document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent, path: location.pathname }; })()`))); } catch (e) { console.log('DBG dump failed ' + e.message); } };
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const where = () => ev(`({ path: location.pathname, group: document.querySelector('${T}')?.dataset.group || '', onGoal: !!document.querySelector('.goals-open'), needs: /looks done/.test(document.querySelector('${T}')?.textContent || ''), scroll: document.querySelector('${T}')?.scrollTop || 0 })`);
    const openNeeds = async () => {
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'a Goal looks done row', 20000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0' });
        const TITLES = ['Ship the pilot', 'Ship the second', ...Array.from({ length: 7 }, (_, i) => 'Ship extra ' + (i + 1))];
        for (const title of TITLES) {
            const g = await api('POST', '/goals', { subscriber_id: 'Operator', title, done_when: 'it is shipped' }); assert.equal(g.status, 201); const gid = g.json.id || g.json.goal.id;
            const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); const tid = t.json.id || t.json.task.id;
            assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
            assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            for (const how of ['the page\'s Back link', 'the browser\'s Back']) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await openNeeds();
                const before = await where(); assert.equal(before.path, '/inbox/needs', at + 'the Needs you address before: ' + JSON.stringify(before));
                await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('.inbox-review-name').click(); true`);
                await waitFor(`!!document.querySelector('.goals-open')`, at + 'the goal opened', 10000);
                const on = await where(); assert.ok(/^\/inbox\/goals\//.test(on.path), at + 'the goal page address: ' + JSON.stringify(on));
                if (how.startsWith('the page')) await ev(`document.querySelector('.goals-open .back-link, .goals-open .goals-back')?.click(); true`); else await ev(`history.back(); true`);
                await waitFor(`!document.querySelector('.goals-open')`, at + 'back from the goal', 10000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the folder draws after the route
                const back = await where();
                assert.equal(back.path, '/inbox/needs', at + `${how}: Back from a goal opened off Needs you lands on Needs you, not the Goals tab: ` + JSON.stringify(back));
                assert.ok(back.needs && back.group === 'hub-inbox:needs', at + `${how}: the Needs you list is on screen: ` + JSON.stringify(back));
                // and one Back more leaves the Inbox's page, not a stray Goals entry (no goals folder was written into the history)
                const prev = await ev(`history.state && history.state.prev || ''`); assert.ok(!/^\/inbox\/goals/.test(prev), at + `${how}: no Goals entry under Needs you: ` + prev);
            }
        }

        // #11964 (QA2's INFO on #11950): Back to a scrolled Needs you list keeps the row's place and its focus. A short window so the nine rows scroll; a real mouse click on a row far down; Back; the list is scrolled
        // to where it was and the row that was opened is still on screen and holds the focus.
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px, a scrolled list: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 420, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await openNeeds();
            const SCROLLER = `(() => { const tr = document.querySelector('${T} tbody tr'); for (let e = tr; e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 2) return e; } return document.scrollingElement; })()`;
            const target = await ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)); const tr = rows[rows.length - 2], sc = ${SCROLLER}; tr.scrollIntoView({ block: 'center' }); return { text: tr.querySelector('.inbox-review-name')?.textContent || '', top: sc.scrollTop, scrollable: sc.scrollHeight > sc.clientHeight + 2, rows: rows.length }; })()`);
            assert.ok(target.scrollable && target.top > 100, at + 'the list scrolls in this window: ' + JSON.stringify(target));
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the scroll settles
            // The list can be redrawn once more after it first appears (the goals' own refresh lands late on a slow machine) and a redraw puts it back near the top, so the row is found again, scrolled to and checked to be under the point before the click, up to five times (v2.0.35 gate: on the runner the first point was below the 420 px window)
            let pos = null;
            for (let attempt = 0; attempt < 5 && !(pos && pos.hit); attempt++) {
                await ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)); rows[rows.length - 2].scrollIntoView({ block: 'center' }); return true; })()`);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the scroll settles, and a late redraw lands before the point is measured
                pos = await ev(`(() => { const row = [...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)).slice(-2)[0], el = row.querySelector('.inbox-review-name'), r = el.getBoundingClientRect(), x = r.left + Math.min(r.width / 2, 20), y = r.top + r.height / 2, at = document.elementFromPoint(x, y); return { x, y, top: ${SCROLLER}.scrollTop, hit: !!at && row.contains(at) }; })()`);
            }
            assert.ok(pos && pos.hit, at + 'the row is under the point where the click will land: ' + JSON.stringify(pos));
            await ev(`(() => { window.__evlog = []; const tbl = document.querySelector('${T}'); for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.addEventListener(t, e => window.__evlog.push([t, Math.round(performance.now()), (e.target.className || e.target.tagName || '').toString().slice(0, 40), (e.target.closest && e.target.closest('tr') ? e.target.closest('tr').dataset.key : '')]), true); const mo = new MutationObserver(m => window.__evlog.push(['mut', Math.round(performance.now()), m.length, m.filter(x => x.removedNodes.length).length])); mo.observe(document.getElementById('group-table-view') || document.body, { childList: true, subtree: true }); window.__evlog.push(['view', innerWidth, innerHeight, document.documentElement.clientHeight, visualViewport && visualViewport.height, window.scrollY, document.body.scrollHeight, (() => { const r = [...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)).slice(-2)[0]; if (!r) return null; const b = r.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), Math.round(b.left), Math.round(b.right)]; })()]); window.__evlog.push(['hit', document.elementFromPoint(${pos.x}, ${pos.y}) ? (document.elementFromPoint(${pos.x}, ${pos.y}).className || document.elementFromPoint(${pos.x}, ${pos.y}).tagName).toString().slice(0, 50) : null, 'scrollTop', document.getElementById('group-table-view') ? document.getElementById('group-table-view').scrollTop : -1]); return true; })()`);
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: pos.x, y: pos.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
            await waitFor(`!!document.querySelector('.goals-open')`, at + 'the goal opened by a real click', 10000).catch(async e => { await dumpDbg('goal_back ' + at + ' pos=' + JSON.stringify(pos)); console.log('DBG evlog ' + JSON.stringify(await ev('window.__evlog'))); throw e; });
            await ev(`history.back(); true`);
            await waitFor(`!document.querySelector('.goals-open') && /looks done/.test(document.querySelector('${T}')?.textContent || '')`, at + 'back on the list', 10000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the folder draws after the route and restores its place
            const after = await ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)), tr = rows.find(r => (r.querySelector('.inbox-review-name')?.textContent || '') === ${JSON.stringify(target.text)}), r = tr && tr.getBoundingClientRect(), a = document.activeElement; return { scroller: (${SCROLLER}).id || (${SCROLLER}).className, top: ${SCROLLER}.scrollTop, rowOnScreen: !!r && r.bottom > 0 && r.top < innerHeight, focusInRow: !!tr && !!a && tr.contains(a), active: a ? a.tagName + '.' + String(a.className).slice(0, 40) : null }; })()`);
            assert.ok(Math.abs(after.top - pos.top) <= 40, at + `Back keeps the scroll position (${pos.top} before, ${JSON.stringify(after)} after)`);
            assert.ok(after.rowOnScreen, at + 'the row that was opened is on screen: ' + JSON.stringify(after));
            assert.ok(after.focusInRow, at + 'and it holds the focus again: ' + JSON.stringify(after));
        }
        console.log('PASS Back from a goal opened off Needs you returns to Needs you');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
