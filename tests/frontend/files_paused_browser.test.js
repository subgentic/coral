// #13079: a repository git is too slow for. The server pauses live updates for the folder (the answer carries paused{changes}): the Files panel says so with Refresh (one pass on demand, manual=1) and Turn on live updates
// (live=on), makes no automatic request while it is paused, and a list that is cut says 'Showing 3 of 35,000 changed files'. Drives Chrome over CDP; the routes are stood in at the page's fetch.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the test shows that nothing is asked in this time, which only waiting can show
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const text = () => ev(`document.getElementById('changed-files-list').textContent.replace(/\\s+/g, ' ')`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.__coralFilesWatchMs = 500; true`);
        await ev(`(() => { const R = window.fetch; window.__calls = []; window.__paused = true;
            const files = [{ filepath: 'a.txt', status: 'modified', additions: 1, deletions: 0 }, { filepath: 'b.txt', status: 'modified', additions: 1, deletions: 0 }, { filepath: 'c.txt', status: 'modified', additions: 1, deletions: 0 }];
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/sessions\\/live\\/wp\\/files\\/refresh$/.test(url.pathname)) { window.__calls.push(url.search); if (url.search.includes('live=on')) window.__paused = false;
                    return json({ files, is_git: true, compare: { label: 'HEAD' }, total_changed: 35000, capped: true, paused: window.__paused ? { changes: 35000, took_ms: 3200 } : undefined }); }
                if (/\\/api\\/sessions\\/live\\/wp\\/files$/.test(url.pathname)) return json({ files, is_git: true, compare: { label: 'HEAD' } });
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude' }; return true; })()`);
        const shown = await ev(`(async () => { const p = document.getElementById('agentic-panel-files'); if (!p) return 'no panel'; window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } } /* no agent is open in this bare page: its dock is shown by hand */ return p.classList.contains('active') && p.getClientRects().length > 0; })()`);
        check('the Files panel can be shown in this page', (await ev('true')) && true);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles({ session_id: 'sid-wp', name: 'wp', working: false, changed_file_count: 0 }); return true; })()`); // the session feed's steady row: nothing moved
        await waitFor(`/Live updates paused/.test(document.getElementById('changed-files-list').textContent)`, 'the paused note', 6000).catch(() => {});
        const t = await text();
        check('a paused folder says so, with its size', /Live updates paused: this repo is large \(35,000 changes\)/.test(t), t.slice(0, 160));
        check('Refresh and Turn on live updates are there', (await ev(`[...document.querySelectorAll('#changed-files-list .files-paused-note button')].map(b => b.textContent.trim()).join('|')`)) === 'Refresh|Turn on live updates');
        const before = await ev(`window.__calls.length`);
        await quiet(2500);
        check('while paused the page asks nothing by itself (5 beats of the watch)', (await ev(`window.__calls.length`)) === before, `${before} then ${await ev('window.__calls.length')}`);
        await ev(`document.querySelector('#changed-files-list .files-paused-note button').click(); true`);
        await waitFor(`window.__calls.length === ${before} + 1`, 'Refresh asks once', 5000);
        check('Refresh asks for one pass on demand (manual=1)', (await ev(`window.__calls[window.__calls.length - 1]`)).includes('manual=1'), await ev(`window.__calls[window.__calls.length - 1]`));
        await ev(`document.querySelector('#changed-files-list .files-paused-note .btn-quiet').click(); true`);
        await waitFor(`window.__calls.some(c => c.includes('live=on'))`, 'Turn on asks with live=on', 5000);
        await waitFor(`!/Live updates paused/.test(document.getElementById('changed-files-list').textContent)`, 'the note goes', 5000);
        check('Turn on live updates asks with live=on and the note goes', true);
        const n = await ev(`window.__calls.length`);
        await waitFor(`window.__calls.length >= ${n} + 2`, 'the watch asks again once live', 6000);
        check('live again: the watch asks by itself', (await ev(`window.__calls.length`)) >= n + 2);
        const head = await ev(`document.getElementById('changed-files-title').textContent.replace(/\\s+/g, ' ')`);
        check('a cut list says how many changed in all', /Showing 3 of 35,000 changed files/.test(head), head.slice(0, 120));
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} paused-folder checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
