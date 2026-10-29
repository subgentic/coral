// Archiving an agent, end to end (#10650, Beta #10573 point 6: "archiving did not take effect: QA Engineer stayed listed, Archived showed 0"): a real terminal agent on a real team, archived from its row's menu
// (Archive, then the confirmation): the agent leaves the main list and the team's group, shows under "Archived (n)", the server says it is archived and asleep, and Inbox > Archived lists it (an agent with no chat yet: "Archived, no messages yet") and opens it.
// 1280 px, isolated dev server.
'use strict';
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { removeBoards, removeTeams } = require('./helpers/board_cleanup');

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const until = (expr, what, ms = 15000) => waitFor(expr, what, { timeout: ms });
    const api = (method, p) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
    let launched = null;
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        const loaded = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await loaded; await coralReady();
        const U = Date.now().toString(36), QA_NAME = 'QA Engineer ' + U; // unique: the shard's server holds what earlier suites left (#11000), so this suite reads only its own rows
        launched = await ev(`fetch('/api/sessions/launch-team', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ board_name: 'archive-${U}', working_dir: ${JSON.stringify(require('node:os').tmpdir())}, agent_type: 'terminal', agents: [{ name: 'Orchestrator', prompt: 'x' }, { name: ${JSON.stringify(QA_NAME)}, prompt: 'x' }] }) })
            .then(r => r.json()).then(j => ({ agents: j.agents, board: j.board }))`);
        const qa = launched.agents.find(a => /QA/.test(a.name || a.display_name || '')) || launched.agents[1];
        const row = sid => `document.querySelector('#live-sessions-list [data-on-click="session-open"][data-session-id="${sid}"]')`;
        const sidebar = () => ev(`(() => { let inArchived = false; const main = [], archived = []; for (const li of document.querySelectorAll('#live-sessions-list li')) { if (li.classList.contains('archived-summary-row')) { inArchived = true; continue; } const sid = li.dataset.sessionId; if (sid) (inArchived ? archived : main).push(sid); } const s = document.querySelector('#live-sessions-list .archived-summary-row'); return { main, archived, summary: s ? s.textContent.trim() : null }; })()`);
        await until(`!!${row(qa.session_id)}`, 'QA Engineer in the list');
        assert.ok((await sidebar()).main.includes(qa.session_id), 'QA Engineer is listed before it is archived');
        // The shard's server is shared: suites before this one leave chats and archived agents behind, so nothing here is an absolute count; it is what THIS archive changes (#11000: 'the agent is not an All chats row  1 !== 0' in CI, a row an earlier suite left).
        const base = { counts: (await api('GET', '/api/sessions/history/counts')).data || {}, archivedInSidebar: Number(/Archived \((\d+)\)/.exec((await sidebar()).summary || '')?.[1] || 0) };

        // Archive from the row's menu, then the confirmation
        await ev(`${row(qa.session_id)}.querySelector('[data-on-click="kebab-toggle"]').click(); true`);
        await until(`!!document.querySelector('#live-sessions-list [data-on-click="agent-archive"][data-session-id="${qa.session_id}"]')`, 'the Archive item');
        await ev(`document.querySelector('#live-sessions-list [data-on-click="agent-archive"][data-session-id="${qa.session_id}"]').click(); true`);
        await until(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the confirmation');
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await until(`(() => { let inA = false; for (const li of document.querySelectorAll('#live-sessions-list li')) { if (li.classList.contains('archived-summary-row')) { inA = true; continue; } if (!inA && li.dataset.sessionId === ${JSON.stringify(qa.session_id)}) return false; } return true; })()`, 'QA Engineer to leave the main list');
        const after = await sidebar();
        assert.ok(!after.main.includes(qa.session_id), 'QA Engineer left the main list: ' + JSON.stringify(after));
        assert.match(after.summary || '', new RegExp(`Archived \\(${base.archivedInSidebar + 1}\\)`), `the sidebar says Archived (${base.archivedInSidebar + 1}), one more than before: ` + JSON.stringify(after));
        await ev(`document.querySelector('#live-sessions-list .archived-summary-row .row-btn').click(); true`); // the section opens
        await until(`!!document.querySelector('#live-sessions-list [data-session-id="${qa.session_id}"]') && [...document.querySelectorAll('#live-sessions-list .archived-summary-row ~ li')].some(li => li.dataset.sessionId === ${JSON.stringify(qa.session_id)})`, 'QA Engineer under Archived once the section is open');

        // the server agrees
        const live = (await api('GET', '/api/sessions/live')).data || [];
        const sess = live.find(s => s.session_id === qa.session_id);
        assert.ok(sess && sess.archived === true && sess.sleeping === true, 'the server lists it archived and asleep: ' + JSON.stringify(sess && { archived: sess.archived, sleeping: sess.sleeping }));
        // Inbox > Archived counts the agent too (it has no chat yet), and its row opens the agent (#10654)
        // The counts are read from the history index, which takes the archive a moment after the sessions list does: wait for Archived to gain this agent. It is an Archived row that gains it and no All chats row.
        let counts = {};
        for (let i = 0; i < 40; i++) { counts = (await api('GET', '/api/sessions/history/counts')).data || {}; if (counts.archived === (base.counts.archived || 0) + 1) break; await new Promise(r => setTimeout(r, 250)); } // sleep-ok: the history index catches up
        assert.equal(counts.archived, (base.counts.archived || 0) + 1, 'Archived gained this agent in the counts: ' + JSON.stringify({ base: base.counts, counts }));
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats-archived')).then(() => true)`);
        await until(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].some(r => /Archived, no messages yet/.test(r.textContent) && r.textContent.includes(${JSON.stringify(QA_NAME)}))`, 'the archived agent\'s row in Inbox > Archived');
        const archivedRow = await ev(`(() => { const r = [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(x => /Archived, no messages yet/.test(x.textContent) && x.textContent.includes(${JSON.stringify(QA_NAME)})); return { text: r.textContent.replace(/\\s+/g, ' ').trim(), buttons: [...r.querySelectorAll('.dt-flag')].length }; })()`);
        assert.ok(archivedRow.text.includes(QA_NAME), 'the row names the agent: ' + JSON.stringify(archivedRow));
        assert.equal(archivedRow.buttons, 0, 'a row with no chat has no Star, Archive or Continue buttons');
        // and this agent is not an All chats row: the folder is read for ITS name only (it holds whatever earlier suites left)
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await until(`!document.querySelector('#group-table-view tbody tr .dt-primary') || document.querySelectorAll('#group-table-view tbody tr').length > 0`, 'the All chats folder is drawn');
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the folder's rows settle
        assert.equal(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].filter(r => r.textContent.includes(${JSON.stringify(QA_NAME)})).length`), 0, 'the agent is not an All chats row');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats-archived')).then(() => true)`);
        await until(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].some(r => r.textContent.includes(${JSON.stringify(QA_NAME)}))`, 'the archived agent\'s row is back in Inbox > Archived');
        await ev(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(x => /Archived, no messages yet/.test(x.textContent) && x.textContent.includes(${JSON.stringify(QA_NAME)})).querySelector('.dt-primary, button, td').click(); true`);
        await until(`import((window.__coralStatic || '/static/') + 'state.js').then(({ state }) => !!state.currentSession && state.currentSession.session_id === ${JSON.stringify(qa.session_id)})`, 'the row opens the agent');

        console.log('PASS Archive: the agent leaves the list, shows under Archived and in Inbox > Archived, which opens it');
    } finally {
        if (launched) {
            for (const a of launched.agents || []) { try { await ev(`fetch('/api/sessions/live/' + encodeURIComponent(${JSON.stringify(a.session_name || a.name)}) + '/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(a.session_id)} }) }).then(() => true)`); } catch { /* best effort */ } }
            await removeBoards(ev, [launched.board]); await removeTeams(ev, [launched.board]);
        }
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
