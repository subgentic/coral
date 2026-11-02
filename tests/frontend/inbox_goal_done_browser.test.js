// "Goal #N looks done" (#11825): an active goal whose tasks are all done is ONE row of Needs you, with its Done-when line, counted in the one Inbox number, and three actions: Close goal (the goal's page with
// its Close dialog set to Done), Not yet (hidden until a task is added) and Dismiss (hidden for good, Undo in the notice). Both are kept on the machine (goal_done_hidden), so /api/needs-you agrees. A goal with
// an open task, and one with no tasks, are not rows. Real board and settings routes on the isolated dev server; 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const B = 'goal-done-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const doneRows = () => ev(`[...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)).map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim(), buttons: [...tr.querySelectorAll('button')].map(b => b.textContent.trim()) }))`);
    const openNeeds = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
    };
    const task = async (gid, finish) => {
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300, JSON.stringify(t));
        const tid = t.json.id || t.json.task.id;
        if (finish) {
            assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
            assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
        return tid;
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '' }); // the default quiet period (15 minutes, #12161) first; read and hidden cleared here, not left to whatever ran before (v2.0.35 gate)
        const mk = async (title, doneWhen) => { const g = await api('POST', '/goals', { subscriber_id: 'Operator', title, done_when: doneWhen }); assert.equal(g.status, 201); return g.json.id || g.json.goal.id; };
        const gid = await mk('Ship the pilot', 'it is shipped');
        await task(gid, true);
        const openGoal = await mk('Still going', 'later'); await task(openGoal, true); await task(openGoal, false);
        await mk('No tasks yet', '');

        // #12161 (the Operator): its tasks are all done, but the last one was finished moments ago: the driver has 15 minutes to add the next tasks, so it is not the Operator's item yet: not in the list, and not in
        // /api/needs-you (the count and the phone push). A suite does not wait 15 minutes: the setting goal_done_quiet_minutes says 0, and the goal is there at once.
        await openNeeds();
        await require('./helpers/wait').settle(ev, 600, 300);
        assert.equal((await doneRows()).length, 0, 'inside its quiet period the goal is not an item of Needs you');
        assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'nor in /api/needs-you');
        await root('PUT', '/api/settings', { goal_done_quiet_minutes: '0' });
        await openNeeds();
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the goal item', 20000);
        let rows = await doneRows();
        assert.equal(rows.length, 1, 'one row: not the goal with an open task, nor the one with no tasks: ' + JSON.stringify(rows));
        assert.match(rows[0].text, new RegExp(`Goal #${gid} looks done: Ship the pilot`));
        assert.match(rows[0].text, /Done when: it is shipped/);
        assert.deepEqual(rows[0].buttons.filter(b => /^(Close goal|Not yet|Dismiss)$/.test(b)), ['Close goal', 'Not yet', 'Dismiss']);
        const badge = async () => Number(await ev(`(document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || 0`));
        const withItem = await badge(); assert.ok(withItem >= 1, 'the item is in the Inbox number: ' + withItem);
        const asked = await root('GET', '/api/needs-you?limit=50');
        assert.ok(asked.json.items.some(i => i.kind === 'goal_done' && i.id === `goal_done:${B}:${gid}`), 'the phone-push read has it too');

        // Not yet: gone here and on the machine, until a task is added
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('button[aria-label^="Not yet"]').click(); true`);
        await waitFor(`!/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the item gone after Not yet', 8000);
        assert.equal(await badge(), withItem - 1, 'and out of the Inbox number');
        const saved = (await root('GET', '/api/settings')).json.settings.goal_done_hidden;
        assert.deepEqual(JSON.parse(saved), [`${B}|${gid}|1`], 'kept on the machine at the total it was pressed at');
        assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'the phone push does not keep announcing it');
        await task(gid, true);
        await openNeeds();
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the item is back after a task was added and finished', 20000);

        // #11983: opening the item reads it: it stays listed and stops counting, in the Inbox number, the badge and /api/needs-you; a task done since has a new total, and it is unread again
        await require('./helpers/wait').settle(ev, 600, 300);
        const unreadBadge = await badge();
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('.inbox-review-name').click(); true`);
        await waitFor(`!!document.querySelector('.goal-view, [data-goal-view], #goal-view') || /goals|goal/i.test(location.hash + location.pathname)`, 'the goal opened', 10000);
        await openNeeds();
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the opened item is still listed', 20000);
        await waitFor(`Number((document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || 0) === ${unreadBadge - 1}`, 'and out of the Inbox number', 10000);
        assert.equal((await doneRows()).length, 1, 'listed once');
        assert.ok(await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).classList.contains('dt-read')`), 'the opened row is drawn read (needsUnread, QA #11983)');
        assert.equal(await ev(`(document.querySelector('${T} .session-group-count') || {}).textContent`), '0', 'the heading counts what the badge counts: nothing unread (needsUnread)');
        assert.ok(await ev(`[...document.querySelectorAll('button.goals-chip')].some(e => /^All 0 of 1$/.test(e.textContent.trim()))`), 'the All pill says 0 unread of the 1 listed (needsUnread)');
        const readSaved = JSON.parse((await root('GET', '/api/settings')).json.settings.goal_done_read);
        assert.equal(readSaved.length, 1);
        assert.match(readSaved[0], new RegExp(`^${B}\\|${gid}\\|2\\|\\d{4}-\\d\\d-\\d\\dT`), 'kept on the machine at the total and the last change it was opened at: ' + readSaved[0]);
        assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'the phone push and /api/needs-you do not count it either');
        await task(gid, true);
        await openNeeds();
        await waitFor(`Number((document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || 0) === ${unreadBadge}`, 'unread again after another task was finished', 20000);
        assert.ok((await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'and in /api/needs-you again');

        // Dismiss with Undo
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('button[aria-label^="Dismiss"]').click(); true`);
        await waitFor(`!/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the item gone after Dismiss', 8000);
        assert.ok(JSON.parse((await root('GET', '/api/settings')).json.settings.goal_done_hidden).includes(`${B}|${gid}|*`), 'Dismiss is kept');
        await waitFor(`!![...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim()))`, 'the Undo in the notice', 5000);
        await ev(`[...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim())).click(); true`);
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'Undo brings it back', 8000);

        // Close goal: the goal's page with the Close dialog set to Done; closing it takes the item away
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('button[aria-label^="Close goal"]').click(); true`);
        await waitFor(`!!document.querySelector('dialog.goals-close-dialog[open]')`, 'the Close dialog', 10000);
        assert.equal(await ev(`document.querySelector('dialog.goals-close-dialog input[name=goal-close-state]:checked')?.value`), 'done', 'set to Done');
        await ev(`[...document.querySelectorAll('dialog.goals-close-dialog button')].find(b => /^(Close goal|Close|Confirm)/.test(b.textContent.trim()) && b.type !== 'button' || /Close goal/.test(b.textContent)).click(); true`);
        await waitFor(`!document.querySelector('dialog.goals-close-dialog[open]')`, 'the dialog closes', 10000);
        await openNeeds();
        await waitFor(`!!document.querySelector('${T} tbody tr, ${T}')`, 'Needs you', 10000);
        await require('./helpers/wait').settle(ev, 600, 300); // the goals were read again when the list opened
        assert.equal((await doneRows()).length, 0, 'gone when the goal closes');
        assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'and from the phone-push read');
        // #12029 (the Mobile Beta Tester): on a phone the row has its title; a long press selects it, and the bar offers Mark read / Mark unread and Dismiss (a phone's Needs you row has no buttons: tap opens, long press selects)
        {
            const gid2 = await mk('Customers sign up without help', 'Ten customers sign up with no support message'); await task(gid2, true);
            await root('PUT', '/api/settings', { goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0' });
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
            await Emulation.setTouchEmulationEnabled({ enabled: true });
            await openNeeds();
            await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the goal item on a phone', 20000);
            const shown = await ev(`(() => {
                const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => /looks done/.test(r.textContent)); if (!tr) return { error: 'no row' };
                const title = [...tr.querySelectorAll('*')].find(e => e.children.length === 0 && /looks done: Customers sign up without help/.test(e.textContent)); if (!title) return { error: 'no title element' };
                title.scrollIntoView({ block: 'center' }); const b = title.getBoundingClientRect(), hit = document.elementFromPoint(b.left + Math.min(20, b.width / 2), b.top + b.height / 2);
                return { w: Math.round(b.width), h: Math.round(b.height), inView: b.left >= 0 && b.right <= innerWidth, onTop: !!hit && (hit === title || title.contains(hit)) }; // the title itself (or a part of it) is what a finger or an eye meets there: not the row it is clipped inside
            })()`);
            assert.ok(shown.w > 40 && shown.h >= 10 && shown.inView && shown.onTop, 'the title is drawn on a phone, not clipped away: ' + JSON.stringify(shown));
            const touch = (type, p) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }] });
            const point = () => ev(`(() => { const r = [...document.querySelectorAll('${T} tbody tr')].find(r => /looks done/.test(r.textContent)); r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.left + b.width * 0.35, y: b.top + b.height * 0.5 }; })()`);
            const press = async () => { const p = await point(); await touch('touchStart', p); await new Promise(r => setTimeout(r, 700)); await touch('touchEnd', p); await new Promise(r => setTimeout(r, 300)); }; // sleep-ok: a long press is a held finger
            await press();
            const bar = await ev(`(() => { const b = document.querySelector('.dt-bar'); return b ? { count: (b.querySelector('.dt-bar-count, .team-tb-count') || b).textContent.replace(/\\s+/g, ' ').trim(), actions: [...b.querySelectorAll('button')].map(x => ({ label: (x.getAttribute('aria-label') || x.textContent).trim(), off: x.disabled })) } : null; })()`);
            assert.ok(bar && /1 selected/.test(bar.count), 'a long press selects the goal row: ' + JSON.stringify(bar));
            const act = label => (bar.actions || []).find(a => a.label === label);
            assert.ok(act('Dismiss') && !act('Dismiss').off, 'Dismiss is on the bar: ' + JSON.stringify(bar.actions));
            assert.ok(!act('Changes') && !act('Approve') && !act('Save for later'), 'a selected goal is not offered the file actions (Changes, Approve, Save for later) (#12401): ' + JSON.stringify(bar.actions.map(a => a.label)));
            assert.ok(act('Close goal') && !act('Close goal').off, 'Close goal is in the bar menu of a selected goal that looks done, reachable on a phone (#12328): ' + JSON.stringify(bar.actions));
            await ev(`document.querySelector('.dt-bar [aria-label="More actions"]')?.click(); true`);
            await waitFor(`!![...document.querySelectorAll('.menu-item, [role=menuitem]')].find(b => /^Not yet$/.test(b.textContent.trim()))`, 'Not yet in the bar menu (#12328)', 5000);
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            await ev(`document.querySelector('.dt-bar [aria-label="More actions"]')?.click(); true`);
            await waitFor(`!![...document.querySelectorAll('.menu-item, [role=menuitem]')].find(b => /^Mark read$/.test(b.textContent.trim()))`, 'Mark read in the bar menu', 5000);
            await ev(`[...document.querySelectorAll('.menu-item, [role=menuitem]')].find(b => /^Mark read$/.test(b.textContent.trim())).click(); true`);
            await waitFor(`JSON.parse((window.state || {}).settings?.goal_done_read || '[]').length === 1 || true`, 'settled', 3000).catch(() => {});
            await require('./helpers/wait').settle(ev, 600, 300);
            const savedRead = JSON.parse((await root('GET', '/api/settings')).json.settings.goal_done_read);
            assert.equal(savedRead.length, 1, 'Mark read from the bar kept the goal as read: ' + JSON.stringify(savedRead));
            assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid2}`), 'and /api/needs-you no longer counts it');
            // #12328, pressed and not only listed: Close goal opens the Close dialog set to Done; Not yet hides several goals at once, with Undo in the notice
            const menuItem = async label => { await ev(`document.querySelector('.dt-bar [aria-label="More actions"]')?.click(); true`); await waitFor(`!![...document.querySelectorAll('.menu-item, [role=menuitem]')].find(b => /^${label}$/.test(b.textContent.trim()))`, label + ' in the bar menu', 5000); await ev(`[...document.querySelectorAll('.menu-item, [role=menuitem]')].find(b => /^${label}$/.test(b.textContent.trim())).click(); true`); await require('./helpers/wait').settle(ev, 600, 300); };
            const gid3 = await mk('Billing page loads fast', 'The billing page loads in under a second'); await task(gid3, true);
            await openNeeds();
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent)).length >= 2`, 'two goals that look done on a phone', 20000);
            const rowAt = i => ev(`(() => { const r = [...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent))[${i}]; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.left + b.width * 0.35, y: b.top + b.height * 0.5 }; })()`);
            const holdRow = async i => { const p = await rowAt(i); await touch('touchStart', p); await new Promise(r => setTimeout(r, 700)); await touch('touchEnd', p); await new Promise(r => setTimeout(r, 300)); }; // sleep-ok: a long press is a held finger
            await holdRow(0);
            await menuItem('Close goal');
            assert.ok(await ev(`!![...document.querySelectorAll('dialog[open], .modal')].find(d => d.getClientRects().length && /Close goal/i.test(d.textContent) && /Done/.test(d.textContent))`), 'Close goal from the bar opens the Close dialog, set to Done');
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await require('./helpers/wait').settle(ev, 400, 200);
            await openNeeds();
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent)).length >= 2`, 'the two goals again', 20000);
            await holdRow(0);
            { const p = await rowAt(1); await touch('touchStart', p); await touch('touchEnd', p); await new Promise(r => setTimeout(r, 300)); } // sleep-ok: a tap adds a row to the selection
            assert.equal(await ev(`(document.querySelector('.dt-bar .dt-bar-count, .dt-bar') || {}).textContent.replace(/\\s+/g, ' ').match(/2 selected/) ? 2 : 0`), 2, 'two goals selected');
            assert.equal(await ev(`[...document.querySelectorAll('.dt-bar button')].some(b => (b.getAttribute('aria-label') || b.textContent).trim() === 'Close goal')`), true, 'Close goal is in the bar');
            await menuItem('Not yet');
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent)).length === 0`, 'both goals hidden until a task is added', 10000);
            assert.equal(JSON.parse((await root('GET', '/api/settings')).json.settings.goal_done_hidden || '[]').length >= 2, true, 'both are hidden on the machine');
            await waitFor(`!![...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim()))`, 'the Undo in the notice', 5000);
            await ev(`[...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim())).click(); true`); await require('./helpers/wait').settle(ev, 800, 300);
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent)).length >= 2`, 'Undo brings both back', 10000);
            // the same for the bar's Dismiss: two goals ignored, Undo, both back (each undo rewrites the one hidden list; run at once, one stayed hidden)
            await openNeeds();
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent)).length >= 2`, 'the two goals for Dismiss', 20000);
            await holdRow(0);
            { const p = await rowAt(1); await touch('touchStart', p); await touch('touchEnd', p); await new Promise(r => setTimeout(r, 300)); } // sleep-ok: a tap adds a row to the selection
            await ev(`document.querySelector('.dt-bar [aria-label="Dismiss"], .dt-bar button[title="Dismiss"]')?.click(); true`);
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent)).length === 0`, 'both goals ignored', 10000);
            await waitFor(`!![...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim()))`, 'the Undo in the notice', 5000);
            await ev(`[...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim())).click(); true`);
            await waitFor(`[...document.querySelectorAll('${T} tbody tr')].filter(r => /looks done/.test(r.textContent)).length >= 2`, 'Undo of Dismiss brings both goals back', 10000);
            await Emulation.setTouchEmulationEnabled({ enabled: false });
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        }
        console.log('\nPASS a goal that looks done is one Needs you item: Done-when line, one Inbox number, Close goal, Not yet and Dismiss with Undo, kept on the machine');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
