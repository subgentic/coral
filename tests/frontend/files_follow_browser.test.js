// The Files list follows the agent (#10268, Desktop pass 21): it showed a stale "+2" until Refresh was pressed. The session feed's row for the open agent says how many files changed and whether
// it is working: the list is read again when that count moves or the turn ends, once for a burst of rows, and not for a row that says nothing new. Drives Chrome over CDP against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
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
        const follow = row => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles(${JSON.stringify(row)}); return true; })()`);
        const reads = () => ev(`window.__filesReads`);
        await follow({ session_id: 'sid-rp', name: 'rp', working: true, changed_file_count: 1 });
        await settle(500);
        check('the first row of an agent only seeds what it says (no read)', (await reads()) === 0, String(await reads()));
        await follow({ session_id: 'sid-rp', name: 'rp', working: true, changed_file_count: 1 });
        await settle(500);
        check('a row that says nothing new reads nothing', (await reads()) === 0, String(await reads()));
        await follow({ session_id: 'sid-rp', name: 'rp', working: false, changed_file_count: 1 });
        await waitFor(`window.__filesReads === 1`, 'a read when the turn ends', 4000).catch(() => {});
        check('the list is read again when the agent finishes its reply', (await reads()) === 1, String(await reads()));
        await follow({ session_id: 'sid-rp', name: 'rp', working: false, changed_file_count: 3 });
        await follow({ session_id: 'sid-rp', name: 'rp', working: false, changed_file_count: 3 });
        await waitFor(`window.__filesReads >= 2`, 'a read when the count moves', 4000).catch(() => {});
        await settle(600);
        check('the list is read again when the changed-file count moves, once for a burst of rows', (await reads()) === 2, String(await reads()));
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'other', session_id: 'sid-other' }; return true; })()`);
        await follow({ session_id: 'sid-rp', name: 'rp', working: false, changed_file_count: 9 });
        await settle(600);
        check('a row of an agent that is not open reads nothing', (await reads()) === 2, String(await reads()));
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Files follow checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
