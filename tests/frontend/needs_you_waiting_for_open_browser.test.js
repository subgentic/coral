// Needs you never draws its "Waiting for" column empty on open (#10581, Beta #10394 point 3: the column was blank for a second): an agent waiting with a question, a review artifact and a failed run, all in Needs you; the
// table is sampled every 25 ms from the first draw, and at no sample may a "Waiting for" header sit over cells that are all empty. 1280 and 390 px, isolated dev server, the harness's page; the review artifact and the runs
// are stood in at their routes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const team = 'waitfor-' + Date.now().toString(36);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Review Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(async () => { localStorage.removeItem('coral-inbox-needs-filters');
                const art = { id: '1'.padStart(64, '0'), name: 'Review file.txt', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - 60000).toISOString(), tags: ['for review'], available: true, uri: 'coral://artifacts/' + '1'.padStart(64, '0') };
                const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                const run = { id: 7, job_id: 3, job_name: 'Nightly', display_name: 'Nightly report', status: 'failed', started_at: new Date(Date.now() - 120000).toISOString(), finished_at: new Date(Date.now() - 110000).toISOString(), error: 'exit 2' };
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: [art], has_more: false });
                    if (u.pathname === '/api/scheduled/runs/recent') return json({ runs: [run] });
                    if (u.pathname === '/api/workflows/runs/recent') return json({ runs: [] });
                    return original(url, opts); };
                window.__m.agents = {}; window.__m.add('ask-bot', 'A', 1, { sleeping: false, board_project: '${team}', session_id: 'wf-sid' });
                const ws = await import(${S} + 'websocket.js'); const { state } = await import(${S} + 'state.js'); if (state.coralWs) { state.coralWs.onclose = null; state.coralWs.onmessage = null; try { state.coralWs.close(); } catch {} }
                ws.handleCoralMessage({ type: 'coral_update', servers: [], sessions: Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Wants to know: Pick a color', waiting_since: new Date(Date.now() - 60000).toISOString() })) });
                window.__snaps = []; (function tick() { const th = [...document.querySelectorAll('#group-table-view th')].map(t => t.textContent.replace(/[\\u2191\\u2193\\u2195]/g, '').trim()); const idx = th.findIndex(t => /^Waiting for/.test(t)); const rows = [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')]; const cells = idx < 0 ? [] : rows.map(r => ((r.children[idx] || {}).textContent || '').trim()); const ar = idx < 0 ? null : rows.find(r => /ask-bot/.test(r.textContent)); window.__snaps.push({ t: Math.round(performance.now()), th, rows: rows.length, cells, agentCell: ar ? ((ar.children[idx] || {}).textContent || '').trim() : null }); if (window.__snaps.length < 120) setTimeout(tick, 25); })();
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await new Promise(r => setTimeout(r, 3200)); // sleep-ok: the samples run for three seconds from the first draw
            const snaps = await ev(`window.__snaps`);
            const withCol = snaps.filter(s => s.th.some(t => /^Waiting for/.test(t)));
            assert.ok(withCol.length > 0 && withCol.some(s => s.rows >= 3), `${w}: the scenario has the column and the three rows (agent, review, run): ` + JSON.stringify(snaps.filter(s => s.rows > 0).slice(-1)));
            const blank = withCol.filter(s => s.rows > 0 && s.cells.length && s.cells.every(c => c === ''));
            const agentBlank = withCol.filter(s => s.agentCell === '');
            assert.deepEqual(agentBlank.map(s => [s.t, s.cells]).slice(0, 2), [], `${w}: the agent row's Waiting for cell was empty in ${agentBlank.length} frames`);
            assert.deepEqual(blank.map(s => [s.t, s.th, s.rows, s.cells]).slice(0, 2), [], `${w}: a Waiting for column with every cell empty was on screen (${blank.length} of ${withCol.length} frames with the column)`);
            console.log(`   ${w}: ${snaps.length} samples, ${withCol.length} with a Waiting for column, ${snaps.filter(s => s.rows > 0).length} with rows; last: ${JSON.stringify(snaps[snaps.length - 1])}`);
        }
        console.log('PASS Needs you never draws an empty Waiting for column on open');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
