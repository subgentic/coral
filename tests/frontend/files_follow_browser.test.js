// The Files list follows the agent (#10268, Desktop pass 21): it showed a stale "+2" until Refresh was pressed. The session feed's row for the open agent says how many files changed and whether
// it is working: the list is read again when that count moves or the turn ends, once for a burst of rows, and not for a row that says nothing new. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the test shows that nothing happens in this time, which only waiting can show
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.__coralFilesWatchMs = 1e9; true`); // the panel's own watch (#10485) has its own test: here the reads are the follow's alone
        await ev(`(() => { const R = window.fetch; window.__filesReads = 0;
            window.fetch = (u, o) => { const url = new URL(String(u), location.href);
                if (/\\/api\\/sessions\\/live\\/rp\\/files(\\/refresh)?($|\\?)/.test(url.pathname + url.search)) { window.__filesReads++; (window.__filesCalls = window.__filesCalls || []).push((o && o.method || 'GET') + ' ' + url.pathname); if (/refresh/.test(url.pathname)) { const t0 = Date.now(); (window.__refreshes = window.__refreshes || []).push(t0); window.__inflight = (window.__inflight || 0) + 1; window.__maxInflight = Math.max(window.__maxInflight || 0, window.__inflight); return new Promise(res => setTimeout(() => { window.__inflight--; res(new Response(JSON.stringify({ files: [], is_git: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }, window.__refreshDelay || 0)); } return Promise.resolve(new Response(JSON.stringify({ files: [], is_git: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'rp', session_id: 'sid-rp', agent_type: 'claude' }; return true; })()`);
        const panel = on => ev(`(async () => { const p = document.getElementById('agentic-panel-files'); if (!p) return 'no panel'; if (${on}) { window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } /* no agent is open in this bare page: its dock is shown by hand */ } } else { p.classList.remove('active'); } return p.classList.contains('active') && p.getClientRects().length > 0; })()`);
        const follow = row => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles(${JSON.stringify(row)}); return true; })()`);
        const reads = () => ev(`window.__filesReads`);
        const rp = (working, count, dirty) => ({ session_id: 'sid-rp', name: 'rp', working, changed_file_count: count, git_state: dirty === undefined ? undefined : { dirty } });
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
        // a file the person or another program changed moves only the repository's count (the header chip), not the agent's tool-call count: the list follows that too, and reads the route's refresh, not its cached list (#10268, Desktop recheck)
        const before = (await reads());
        await follow(rp(false, 5, 0)); await quiet(500); await follow(rp(false, 5, 1));
        await waitFor(`window.__filesReads >= ${before} + 1`, 'a read when the repository count moves', 4000).catch(() => {});
        await quiet(500);
        check('the list is read again when only the repository\'s uncommitted count moves', (await reads()) === before + 1, `${before} then ${await reads()}`);
        const calls = await ev(`JSON.stringify(window.__filesCalls)`);
        check('every read of the follow is the route\'s refresh, not its cached list', JSON.parse(calls).every(c => /^POST .*\/files\/refresh$/.test(c)) && JSON.parse(calls).length >= 3, calls);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'other', session_id: 'sid-other' }; return true; })()`);
        await follow(rp(false, 9)); await quiet(600);
        check('a row of an agent that is not open reads nothing', (await reads()) === before + 1, String(await reads()));
        // a burst: rows that move the count every 350 ms for 4 s, each refresh taking 900 ms: one at a time, about 2 s apart, one more after the one in flight and not one each
        await ev(`window.__refreshes = []; window.__maxInflight = 0; window.__refreshDelay = 900; (async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'rp', session_id: 'sid-rp', agent_type: 'claude' }; })(); true`);
        await panel(true);
        for (let n = 20; n < 31; n++) { await follow(rp(false, n)); await quiet(350); }
        await quiet(3500);
        const stamps = await ev(`window.__refreshes.slice()`);
        const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
        check('a burst is refreshed one at a time', (await ev(`window.__maxInflight`)) === 1, String(await ev(`window.__maxInflight`)));
        check('two refreshes are at least about 2 s apart', gaps.length >= 1 && gaps.every(g => g >= 1900), JSON.stringify(gaps));
        check('a burst of eleven rows is a few refreshes, not eleven', stamps.length >= 2 && stamps.length <= 4, String(stamps.length));
        // a view-only viewer on a Hub has no refresh to call: it reads the list
        await ev(`window.__refreshDelay = 0; window.__filesCalls = []; (async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'rp', session_id: 'sid-rp', agent_type: 'claude', hubReadOnly: { message: 'View only', chip: 'View only' } }; })(); true`);
        await follow(rp(false, 40)); await quiet(900);
        const viewCalls = await ev(`JSON.stringify(window.__filesCalls)`);
        check('a view-only viewer reads the list, it does not call the refresh', JSON.parse(viewCalls).length >= 1 && JSON.parse(viewCalls).every(c => /^GET /.test(c)), viewCalls);
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Files follow checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
