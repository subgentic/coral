// Removing a team and the team page's More menu (#16895, walk 39 step 4): (1) after Remove team the "Goal #N closed as done by <agent> ... Reopen" row of that team leaves the Inbox at once (it stayed for up to a minute,
// for a team that no longer exists, with a Reopen that could only fail); (2) the Remove dialog is short lines, not one paragraph, and says what happens to the files the team's agents uploaded; (3) in the More menu the
// words "Agents stop receiving new messages until you resume" sit under Pause team, not under Save as template. Real server, a stood-in terminal session (removed again); 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const B = 'trc-' + Date.now().toString(36);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Closer QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: sname })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Habit tracker', outcome: 'A small app', done_when: 'It runs' }); assert.equal(g.status, 201); const id = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/goals/${id}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Code written' })).status, 200);
        const rowText = `Goal #${id} closed as done by orch`;
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
        await waitFor(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes(${JSON.stringify(rowText)}))`, 'the agent-closed goal has its row', 20000);

        // (3) the More menu: Pause team's words are under Pause team
        await Page.navigate({ url: BASE + '/team/' + B + '/messages' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); // the Messages tab first: its board controls make Pause's words before the menu adopts the button
        await waitFor(`!!document.getElementById('team-page-title') && document.getElementById('team-page-title').textContent.includes('trc-')`, 'the team page', 15000);
        await ev(`document.getElementById('team-page-more').click(); true`);
        await waitFor(`!!document.getElementById('mb-pause-note')?.getClientRects().length`, 'the menu with Pause team and its words', 8000);
        const order = await ev(`(() => { const menu = document.getElementById('team-page-more-menu'), kids = [...menu.children], at = id => kids.findIndex(e => e.id === id), note = document.getElementById('mb-pause-note'); return { pause: at('mb-pause-btn'), note: kids.indexOf(note), template: at('team-page-more-template'), noteText: note.textContent, prev: note.previousElementSibling && note.previousElementSibling.id }; })()`);
        await shot('team-more-menu');
        assert.ok(order.pause >= 0 && order.note === order.pause + 1 && order.prev === 'mb-pause-btn', "Pause team's words are right under Pause team: " + JSON.stringify(order));
        assert.ok(Math.abs(order.note - order.template) > 1, "and not under Save as template: " + JSON.stringify(order));

        // paused too: the words change (Resume), and they are still under the one they describe
        await ev(`document.getElementById('mb-pause-btn').click(); true`);
        await waitFor(`/^Resume/.test(document.getElementById('mb-pause-btn').textContent)`, 'the board is paused (the button says Resume)', 8000);
        await ev(`document.getElementById('team-page-more').click(); true`);
        await waitFor(`!!document.getElementById('mb-pause-note')?.getClientRects().length`, 'the menu again', 8000);
        const paused = await ev(`(() => { const note = document.getElementById('mb-pause-note'); return { prev: note.previousElementSibling && note.previousElementSibling.id, text: note.textContent }; })()`);
        assert.ok(paused.prev === 'mb-pause-btn' && /resume/i.test(paused.text), 'paused: the Resume words are right under the Resume button: ' + JSON.stringify(paused));
        await ev(`document.getElementById('mb-pause-btn').click(); true`); // resumed again; the menu closes on the click
        await waitFor(`/^Pause/.test(document.getElementById('mb-pause-btn').textContent)`, 'the board is resumed', 8000);
        await ev(`document.getElementById('team-page-more').click(); true`);
        await waitFor(`!!document.getElementById('mb-delete-btn')?.getClientRects().length`, 'the menu with Remove team', 8000);
        // (2) the dialog, then (1) the row goes with the team
        await ev(`document.getElementById('mb-delete-btn').click(); true`);
        await waitFor(`document.getElementById('confirm-modal').getClientRects().length > 0`, 'the Remove dialog', 8000, `JSON.stringify({ btn: !!document.getElementById('mb-delete-btn'), hidden: document.getElementById('mb-delete-btn')?.hidden, disp: document.getElementById('mb-delete-btn') && getComputedStyle(document.getElementById('mb-delete-btn')).display, modal: getComputedStyle(document.getElementById('confirm-modal')).display, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.slice(0, 80)) })`);
        const d = await ev(`(() => { const m = document.getElementById('confirm-modal-message'); const lines = m.innerText.split('\\n').map(l => l.trim()).filter(Boolean); return { lines, longest: Math.max(...lines.map(l => l.length)), h: Math.round(m.getBoundingClientRect().height) }; })()`);
        await shot('team-remove-dialog');
        assert.ok(d.lines.length >= 5 && d.longest <= 150, 'the Remove dialog is short lines, not one paragraph: ' + JSON.stringify(d));
        assert.ok(d.lines.some(l => /uploaded/i.test(l) && /not deleted|stay/i.test(l)), "it says what happens to the files the team's agents uploaded: " + JSON.stringify(d.lines));
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Removed team/.test(t.textContent))`, 'the removal is done (the toast)', 20000, `JSON.stringify({ toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.slice(0, 100)), modal: getComputedStyle(document.getElementById('confirm-modal')).display })`);
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
        await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the Inbox draws from what it already read; a second would be a refetch, which is what the fix avoids
        assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes(${JSON.stringify(rowText)}))`), false, 'the removed team leaves no "Goal closed ... Reopen" row in the Inbox');
        console.log('team_remove_cleanup: ok');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).catch(() => {}); true`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
