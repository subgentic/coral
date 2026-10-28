// The Files list follows the agent (#10268, Desktop pass 21): it showed a stale "+2" until Refresh was pressed. The session feed's row for the open agent says how many files changed and whether
// it is working: the list is read again when that count moves or the turn ends, once for a burst of rows, and not for a row that says nothing new. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the test shows that nothing happens in this time, which only waiting can show
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(() => { const R = window.fetch; window.__filesReads = 0;
            window.fetch = (u, o) => { const url = new URL(String(u), location.href);
                if (/\\/api\\/sessions\\/live\\/rp\\/files($|\\?)/.test(url.pathname + url.search)) { window.__filesReads++; return Promise.resolve(new Response(JSON.stringify({ files: [], is_git: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'rp', session_id: 'sid-rp', agent_type: 'claude' }; return true; })()`);
        const panel = on => ev(`(async () => { const p = document.getElementById('agentic-panel-files'); if (!p) return 'no panel'; if (${on}) { window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } /* no agent is open in this bare page: its dock is shown by hand */ } } else { p.classList.remove('active'); } return p.classList.contains('active') && p.getClientRects().length > 0; })()`);
        const follow = row => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles(${JSON.stringify(row)}); return true; })()`);
        const reads = () => ev(`window.__filesReads`);
        const rp = (working, count) => ({ session_id: 'sid-rp', name: 'rp', working, changed_file_count: count });
        // the Files panel is not showing: the first row seeds, then a reply that ends and a count that moves are not read (they are read when the panel opens)
        check('the Files panel is not showing to begin with', (await panel(false)) === false);
        await follow(rp(true, 1)); await quiet(500);
        check('the first row of an agent only seeds what it says (no read)', (await reads()) === 0, String(await reads()));
        await follow(rp(false, 1)); await follow(rp(false, 2)); await quiet(800);
        check('a Files panel that is not showing is not read for a reply that ends or a count that moves', (await reads()) === 0, String(await reads()));
        // showing: the same rows are read
        const shown = await panel(true);
        check('the Files panel can be shown in this page', shown === true, String(shown));
        await quiet(900); await ev(`window.__filesReads = 0; true`);
        await follow(rp(false, 2)); await quiet(500);
        check('a row that says nothing new reads nothing', (await reads()) === 0, String(await reads()));
        await follow(rp(true, 2)); await follow(rp(false, 2));
        await waitFor(`window.__filesReads === 1`, 'a read when the turn ends', 4000).catch(() => {});
        check('the list is read again when the agent finishes its reply', (await reads()) === 1, String(await reads()));
        await follow(rp(false, 5)); await follow(rp(false, 5));
        await waitFor(`window.__filesReads >= 2`, 'a read when the count moves', 4000).catch(() => {});
        await quiet(600);
        check('the list is read again when the changed-file count moves, once for a burst of rows', (await reads()) === 2, String(await reads()));
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'other', session_id: 'sid-other' }; return true; })()`);
        await follow(rp(false, 9)); await quiet(600);
        check('a row of an agent that is not open reads nothing', (await reads()) === 2, String(await reads()));
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Files follow checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
