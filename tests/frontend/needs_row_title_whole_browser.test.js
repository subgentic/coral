// #22094: full agent identity in metadata and whole question title; former mail-column placement retired.
// The name on a phone's Needs you row is read whole (walk 74 item 6, #17875): it shared one line with the question and was cut to 48 percent of it, "Orchestrat…" / "Frontend Dev Tea…", while the question took the rest.
// The name keeps what it needs (up to 70 percent) and the question gets what is left. 390 px, isolated dev server, stubbed waiting agents as in needs_row_opens_chat. Shots in CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => { const entry = window.__m.entry.bind(window.__m); const names = { 'w1-id': 'Orchestrator', 'w2-id': 'Frontend Dev Teams UI' };
            window.__m.entry = a => ({ ...entry(a), display_name: names[a.session_id], board_job_title: names[a.session_id], waiting_for_input: true, waiting_kind: 'needs_input', waiting_summary: 'Wants to know: Which option do you want for the layout of the phone cards?' });
            window.__m.add('w1', 'A', 4, { sleeping: false, board_project: 'coral-go-team', session_id: 'w1-id' }); window.__m.add('w2', 'A', 4, { sleeping: false, board_project: 'coral-go-team', session_id: 'w2-id' }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, 'agents', 8000);
        await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }); true`);
        await waitFor(`document.getElementById('group-table-view')?.dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .nl-row').length >= 2`, 'the Needs you rows', 8000);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the rows settle after the list render
        const rows = await ev(`[...document.querySelectorAll('#group-table-view .nl-row')].map(tr => { const t = tr.querySelector('.nl-meta > .agent-link, .nl-meta > .agent-name'), s = tr.querySelector('.nl-title'); return t && { name: t.textContent, cut: t.scrollWidth > t.clientWidth + 1, snippetW: Math.round(s ? s.clientWidth : 0) }; })`);
        const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/needs-row-390.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        assert.equal(rows.length, 2, JSON.stringify(rows));
        for (const r of rows) { assert.equal(r.cut, false, `the name is read whole: ${JSON.stringify(rows)}`); assert.ok(r.snippetW >= 40, `the question keeps some room: ${JSON.stringify(rows)}`); }
        console.log('PASS the name on a phone Needs you row is read whole');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
