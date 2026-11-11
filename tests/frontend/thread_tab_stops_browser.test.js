// One tab stop for one agent in a comment thread (#15174, Beta walk 7 L15: "Open Orchestrator" twice in a row in the Tab order): in a thread whose comment was sent to an agent that has also replied, no two focusable
// elements of the card have the same name next to each other. Stubbed comments API. 1280 px.
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'f'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        await ev(`(() => { const real = window.fetch, ago = ms => new Date(Date.now() - ms).toISOString();
            const mk = (id, parent, body, mine, extra) => ({ id, parent_id: parent, anchor: parent ? null : { quote: 'The plan.', start_line: 3, end_line: 3 }, body, author: { kind: mine ? 'owner' : 'agent', issuer: 'local', subject: mine ? 'Operator' : 'Orchestrator' }, created_at: ago(300000), ...extra });
            window.__cs = [mk(1, null, 'Is this right?', true, { asks: [{ agent: 'Orchestrator', open: true, replies: 1, seen: true, read_at: ago(200000) }] }), mk(2, 1, 'Yes.', false, { created_at: ago(100000) })];
            const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
                if (url.includes('/api/artifacts/${HEX}/comments') && method === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: c.author.kind === 'owner', can: { reply: c.parent_id == null, edit: false, delete: false, resolve: c.parent_id == null } })), locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response('# Plan\\n\\nThe plan.\\n', { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                return real(u, o); }; return true; })()`);
        await ev(`T.state.liveSessions = [{ session_id: 'orch1', name: 'orch', display_name: 'Orchestrator', board_subscriber_id: 'Orchestrator', agent_type: 'claude', status: 'idle', server: 'local', working_directory: '/w', board_project: 'kb-team' }]; true`);
        await ev(`import(${S} + 'safe_storage.js').then(({ browserLocal }) => { browserLocal.set('coral-artifact-comments-open', 'open'); browserLocal.set('coral-artifact-comments:text/markdown', 'open'); return true; })`);
        await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'kb-team' })); true`);
        await waitFor(`!!document.querySelector('.ac-card[data-id="1"] .ac-ask-status')`, 'the thread with its status line', 10000);
        await ev(`new Promise(r => setTimeout(r, 500))`); // sleep-ok: the links to live agents are drawn after the card
        const stops = await ev(`(() => { const card = document.querySelector('.ac-card[data-id="1"]'); const name = e => (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim();
            return [...card.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"]')].filter(e => e.tabIndex >= 0 && e.getClientRects().length && !e.closest('[aria-hidden="true"]')).map(name); })()`);
        const dup = stops.filter((n, i) => i && n === stops[i - 1]);
        if (dup.length) problems.push('the same name twice in a row in the thread\'s Tab order: ' + JSON.stringify(stops));
        const orch = stops.filter(n => /Open Orchestrator/.test(n)).length;
        if (orch > 1) problems.push('"Open Orchestrator" is ' + orch + ' tab stops in the thread: ' + JSON.stringify(stops));
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('thread_tab_stops_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
