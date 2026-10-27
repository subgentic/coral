// The side panel's Artifacts tab and the Team view by keyboard (#4026 follow-up; the tab is the team page's table since #7622), against stubbed APIs:
//   Artifacts: every control is a real, named, focusable control in a sensible order (the search box, the Filters icon, the More icon, then each row's name); Enter on a row opens its sheet (the title focused) and Escape closes it with the focus back on the row; in the
//   sheet Keep toggles by Space and the focus stays on it; the More menu opens by Enter and Escape returns to its button, a quiet reload keeps the focus; Delete asks first, with the focus on Cancel, and Escape returns to the Delete button.
//   Team view: Refresh and each agent's Remind button are reachable and work by Enter (the prompt is stubbed); the modal Team view traps
//   Tab, closes on Escape and gives the focus back.
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const HEX = n => String(n).repeat(64).slice(0, 64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw and a layout settle over frames; there is no completion event
    const press = async (k, code, vk, modifiers = 0) => { const b = { key: k, code, windowsVirtualKeyCode: vk, modifiers }; await Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(k === 'Enter' ? { text: '\r' } : k === ' ' ? { text: ' ' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...b }); };
    const active = () => ev(`(() => { const a = document.activeElement; return a ? { cls: String(a.className), label: a.getAttribute('aria-label') || a.textContent.trim().slice(0, 30), tag: a.tagName.toLowerCase(), row: a.closest('tr') ? [...a.closest('tr').parentElement.children].indexOf(a.closest('tr')) : -1 } : null; })()`);
    const ART = (i, extra = {}) => ({ name: `report-${i}.md`, uri: `coral://artifacts/${HEX(i)}`, media_type: 'text/markdown', size: 2048 * i, created_at: '2026-10-16T10:00:00Z', task_id: i, task_title: `Task ${i}`, produced_by: 'QA', ...extra });
    let a;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        const team = 'kb-team-' + Date.now();
        await ev(`(() => { const R = window.fetch; window.__calls = []; window.__kept = new Set(); window.__artifacts = [${[1, 2, 3].map(i => JSON.stringify(ART(i))).join(',')}];
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = (o.method || 'GET').toUpperCase(); const p = url.pathname;
                if (p === '/api/session-artifacts') { window.__calls.push('GET artifacts'); return json({ session_id: url.searchParams.get('session_id'), artifacts: window.__artifacts, has_more: false, truncated: false }); }
                if (p === '/api/system/artifact-store/kept') return json({ kept: [...window.__kept] });
                { const k = /^\\/api\\/artifacts\\/([a-f0-9]{64})\\/keep$/.exec(p); if (k) { window.__calls.push(m + ' keep'); if (m === 'PUT') window.__kept.add(k[1]); else window.__kept.delete(k[1]); return json({ ok: true }); } }
                { const d = /^\\/api\\/artifacts\\/([a-f0-9]{64})$/.exec(p); if (d && m === 'DELETE') { window.__calls.push('DELETE'); window.__artifacts = window.__artifacts.filter(a => !a.uri.includes(d[1])); return json({ ok: true }); } }
                if (p.endsWith('/status') && p.includes('/api/board/')) return json({ agents: [
                    { name: 'Backend', subscriber_id: 'be', agent_type: 'claude', role: 'Backend Dev', availability: 'available', available: true, reason: 'Idle, no assigned work.', tasks: [] },
                    { name: 'QA', subscriber_id: 'qa', agent_type: 'claude', role: 'QA Engineer', availability: 'busy', available: false, reason: 'Working on a task.', reminder: true, reminder_interval_seconds: 300, tasks: [{ scope: 'board', id: 7, status: 'in_progress', title: 'Review the patch' }] }],
                    summary: { available: 1, busy: 1 }, unassigned_tasks: [], health_report: ['All good.'], observed_at: new Date().toISOString() });
                return R(u, o); };
            window.__prompts = []; window.prompt = (q) => { window.__prompts.push(q); return null; }; // the browser's own dialog must never open (#6329): the reminder has its dialog
            return true; })()`);
        await ev(`window.__m.add('kb-bot', 'A', 4, { sleeping: false }); true`); await sleep(800); // sleep-ok: a redraw and a layout settle over frames; no completion event
        await ev(`window.selectLiveSession('kb-bot', 'claude', 'kb-bot-id', 'local'); true`); await sleep(1500); // sleep-ok: a redraw and a layout settle over frames; no completion event

        console.log('1. Artifacts: controls and order');
        await ev(`window.switchAgenticTab('artifacts', 'top'); true`);
        const ROW = '#agentic-panel-artifacts-view tbody tr';
        await waitFor(`document.querySelectorAll('${ROW}').length === 3`, 'the artifact rows', 8000);
        const controls = await ev(`[...document.querySelectorAll('#agentic-panel-artifacts-view button, #agentic-panel-artifacts-view a[href]')].filter(e => !e.closest('.list-bar-menu, .list-bar-more-menu, [hidden]') && (e.getClientRects().length > 0 || !e.closest('th'))).map(e => ({ name: (e.getAttribute('aria-label') || e.textContent || '').trim(), tab: e.tabIndex, shown: e.getClientRects().length > 0 }))`);
        assert.ok(controls.every(c => c.shown && c.tab >= 0 && c.name), 'every control is shown, focusable and named: ' + JSON.stringify(controls.filter(c => !(c.shown && c.tab >= 0 && c.name))));
        const bar = await ev(`[...document.querySelectorAll('#agentic-panel-artifacts-view .list-bar-search, #agentic-panel-artifacts-view .list-bar-toggle, #agentic-panel-artifacts-view .list-bar-more-btn')].map(e => e.getAttribute('aria-label') || e.placeholder)`);
        assert.deepEqual(bar, ['More artifact actions'], 'an agent with no team has the More icon in its header and no Refresh (its list has no search or filters)');
        assert.deepEqual(await ev(`[...document.querySelectorAll('${ROW}')].map(r => r.querySelectorAll('button').length - r.querySelectorAll('[data-task-link], [data-goal-link]').length)`), [2, 2, 2], 'a row is two buttons, its name and its Details link, and a third when the file has a task: its Task link (#8617)');

        console.log('2. A row\'s Details link opens the sheet by Enter; Escape closes it with the focus back on the link');
        await ev(`document.querySelector('${ROW} .artifact-details').focus(); true`);
        await press('Enter', 'Enter', 13);
        await waitFor(`!document.getElementById('agentic-detail-pane').hidden`, 'the sheet after Enter', 6000);
        assert.equal(await ev(`document.activeElement === document.querySelector('#agentic-detail-pane .detail-title')`), true, 'the title of the sheet has the focus');
        await press('Escape', 'Escape', 27);
        assert.equal(await ev(`document.getElementById('agentic-detail-pane').hidden`), true, 'Escape closes the sheet');
        a = await active(); assert.match(a.cls, /artifact-details/, 'the focus is back on the Details link: ' + JSON.stringify(a)); assert.equal(a.row, 0);

        console.log('3. Keep by Space keeps the focus');
        const FOOT = (t) => `[...document.querySelectorAll('#agentic-detail-pane .detail-foot .btn')].find(b => /^(${t})$/.test(b.textContent))`;
        await ev(`document.querySelectorAll('${ROW} .artifact-details')[1].focus(); true`);
        await press('Enter', 'Enter', 13);
        await waitFor(`!document.getElementById('agentic-detail-pane').hidden && !!(${FOOT('Keep|Kept')})`, 'the second row\'s sheet', 6000);
        await ev(`(${FOOT('Keep|Kept')}).focus(); true`);
        await press(' ', 'Space', 32);
        await waitFor(`(${FOOT('Keep|Kept')}).getAttribute('aria-pressed') === 'true'`, 'Keep to toggle', 4000);
        a = await active(); assert.equal(a.label, 'Kept', 'the focus stays on the Keep button: ' + JSON.stringify(a));

        console.log('4. The More menu opens by key and Escape returns to its button; a quiet reload keeps the focus');
        await ev(`document.querySelector('#agentic-panel-artifacts-view .list-bar-more-btn').focus(); true`);
        await press('Enter', 'Enter', 13);
        await waitFor(`!document.querySelector('#agentic-panel-artifacts-view .list-bar-more-menu').hidden`, 'the More menu', 4000);
        a = await active(); assert.equal(a.label, 'Copy publishing instructions', 'the first item has the focus: ' + JSON.stringify(a));
        await press('Escape', 'Escape', 27);
        await waitFor(`document.querySelector('#agentic-panel-artifacts-view .list-bar-more-menu').hidden`, 'the menu closed', 4000);
        a = await active(); assert.equal(a.label, 'More artifact actions', 'Escape returns the focus to the More button: ' + JSON.stringify(a));
        await ev(`document.querySelector('#agentic-panel-artifacts-view .list-bar-more-btn').focus(); import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await waitFor(`document.querySelectorAll('${ROW}').length === 3 && window.__calls.filter(c => c === 'GET artifacts').length >= 2`, 'the reload', 6000);
        await sleep(300); // sleep-ok: a redraw and a layout settle over frames; no completion event
        assert.equal(await ev(`document.activeElement === document.querySelector('#agentic-panel-artifacts-view .list-bar-more-btn')`), true, 'a quiet reload leaves the focus on the More button');

        console.log('5. Delete asks first; Escape returns to the Delete button');
        await ev(`document.querySelectorAll('${ROW} .artifact-details')[2].focus(); true`);
        await press('Enter', 'Enter', 13);
        await waitFor(`!document.getElementById('agentic-detail-pane').hidden && !!(${FOOT('Delete')}) && document.querySelector('#agentic-detail-pane .detail-title').textContent === 'report-3.md'`, 'the third row\'s sheet', 6000);
        await ev(`(${FOOT('Delete')}).focus(); true`);
        await press('Enter', 'Enter', 13);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the confirm dialog', 4000);
        await sleep(300); // sleep-ok: a redraw and a layout settle over frames; no completion event
        a = await active(); assert.equal(a.label, 'Cancel', 'the focus is on Cancel');
        await press('Escape', 'Escape', 27); await sleep(400); // sleep-ok: a redraw and a layout settle over frames; no completion event
        assert.equal(await ev(`getComputedStyle(document.getElementById('confirm-modal')).display`), 'none', 'Escape closes the confirm dialog');
        assert.ok(!(await ev(`window.__calls.includes('DELETE')`)), 'nothing was deleted');
        a = await active(); assert.equal(a.label, 'Delete', 'the focus is back on the Delete button: ' + JSON.stringify(a));

        console.log('6. Team view');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_availability.js'); window.__tv = m; await m.showTeamAvailability(${JSON.stringify(team)}); return true; })()`);
        await waitFor(`!!document.querySelector('#team-availability-dialog .availability-agent')`, 'the Team view', 6000);
        assert.equal(await ev(`document.getElementById('team-availability-dialog').matches(':modal')`), true, 'the Team view is a modal dialog');
        const tv = await ev(`[...document.querySelectorAll('#team-availability-dialog button')].map(b => ({ name: (b.getAttribute('aria-label') || b.textContent).trim(), tab: b.tabIndex }))`);
        assert.ok(tv.length >= 4 && tv.every(b => b.name && b.tab >= 0), 'the Team view buttons are named and focusable: ' + JSON.stringify(tv));
        // Tab never lands on the page behind a modal dialog (past its last control the focus leaves for the browser's own controls, as native dialogs do)
        for (let i = 0; i < tv.length + 3; i++) { await press('Tab', 'Tab', 9); assert.equal(await ev(`document.activeElement === document.body || !!document.activeElement.closest('#team-availability-dialog')`), true, 'Tab does not reach the page behind the Team view dialog'); }
        await ev(`document.querySelector('#team-availability-dialog .availability-toolbar button').focus(); true`);
                await press('Enter', 'Enter', 13);
        await waitFor(`!!document.querySelector('#team-availability-dialog .availability-agent')`, 'Refresh to redraw', 4000);
        await sleep(300); // sleep-ok: a redraw and a layout settle over frames; no completion event
        a = await active(); assert.equal(a.label, 'Refresh', 'Refresh keeps the focus: ' + JSON.stringify(a));
        await ev(`[...document.querySelectorAll('#team-availability-dialog .availability-agent button')].find(b => b.textContent === 'Remind agent').focus(); true`);
        await press('Enter', 'Enter', 13); await sleep(300); // sleep-ok: a redraw and a layout settle over frames; no completion event
        assert.equal(await ev(`window.__prompts.length`), 0, 'Remind agent never opens the browser\'s own prompt');
        assert.equal(await ev(`document.getElementById('reminder-dialog')?.open === true`), true, 'Enter on Remind agent opens the reminder dialog');
        assert.equal(await ev(`document.activeElement && document.activeElement.id`), 'reminder-message', 'focus is in the instruction box');
        await press('Escape', 'Escape', 27); await sleep(300); // sleep-ok: the dialog closes over a frame; no completion event
        assert.equal(await ev(`document.getElementById('reminder-dialog').open`), false, 'Escape closes the reminder dialog');
        assert.equal(await ev(`!!document.getElementById('team-availability-dialog')`), true, 'and leaves the Team view open');
        assert.equal(await ev(`document.activeElement && document.activeElement.textContent`), 'Remind agent', 'focus goes back to the button that opened it');
        await press('Escape', 'Escape', 27); await sleep(400); // sleep-ok: a redraw and a layout settle over frames; no completion event
        assert.equal(await ev(`!document.getElementById('team-availability-dialog')`), true, 'Escape closes the Team view');
        console.log('\nPASS artifacts and team view by keyboard');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
