// The Files panel notices a file changed outside the agent (#10485, Desktop recheck: it said "0 files changed" for 8 s after a file was changed by hand, until Refresh was pressed): while the panel is showing
// for a live agent the list is read again every few seconds with the route's refresh, drawn only when it moved, and the reading stops when the panel is not showing. Drives Chrome over CDP.
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
        await ev(`window.__coralFilesWatchMs = 600; true`);
        await ev(`(() => { const R = window.fetch; window.__refreshes = 0; window.__gets = 0; window.__files = [];
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/sessions\\/live\\/wp\\/files\\/refresh$/.test(url.pathname)) { window.__refreshes++; return json({ files: window.__files, is_git: true, compare: { label: 'HEAD' } }); }
                if (/\\/api\\/sessions\\/live\\/wp\\/files$/.test(url.pathname)) { window.__gets++; return json({ files: window.__files, is_git: true, compare: { label: 'HEAD' } }); }
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude' }; return true; })()`);
        const shown = await ev(`(async () => { const p = document.getElementById('agentic-panel-files'); if (!p) return 'no panel'; window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } } /* no agent is open in this bare page: its dock is shown by hand */ return p.classList.contains('active') && p.getClientRects().length > 0; })()`);
        check('the Files panel can be shown in this page', shown === true, String(shown));
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles({ session_id: 'sid-wp', name: 'wp', working: false, changed_file_count: 0 }); return true; })()`); // the session feed's steady row: nothing moved
        await waitFor(`window.__refreshes >= 1`, 'the watch reads the list with no agent activity at all', 6000).catch(() => {});
        check('with no change reported by the agent, the showing panel reads the list by itself', (await ev(`window.__refreshes`)) >= 1, String(await ev(`window.__refreshes`)));
        const none = await ev(`document.getElementById('changed-files-list').textContent`);
        await ev(`window.__files = [{ filepath: 'notes.txt', status: 'modified', additions: 1, deletions: 0 }]; true`);
        await waitFor(`/notes\\.txt/.test(document.getElementById('changed-files-list').textContent)`, 'the file changed outside the agent shows in the list', 6000).catch(() => {});
        check('a file changed outside the agent shows without pressing Refresh', /notes\.txt/.test(await ev(`document.getElementById('changed-files-list').textContent`)), none);
        // a view-only viewer on a Hub reads the list (no refresh to call): the watch's reads draw nothing while the list is the same, and draw it when it moved
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude', hubReadOnly: true }; window.__mut = 0; new MutationObserver(r => { window.__mut += r.length; }).observe(document.getElementById('changed-files-list'), { childList: true, subtree: true, characterData: true, attributes: true }); window.__gets = 0; return true; })()`);
        await waitFor(`window.__gets >= 3`, 'three reads of the list by a view-only viewer', 8000);
        check('a view-only viewer\'s watch redraws nothing while the list is the same', (await ev(`window.__mut`)) === 0, String(await ev(`window.__mut`)));
        await ev(`window.__files = window.__files.concat([{ filepath: 'more.txt', status: 'modified', additions: 1, deletions: 0 }]); true`);
        await waitFor(`/more\\.txt/.test(document.getElementById('changed-files-list').textContent)`, 'the moved list is drawn for a view-only viewer', 6000).catch(() => {});
        check('and draws it when it moved', /more\.txt/.test(await ev(`document.getElementById('changed-files-list').textContent`)));
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude' }; return true; })()`);
        // not showing: the watch stops
        await ev(`document.getElementById('agentic-panel-files').classList.remove('active'); true`);
        await quiet(900); const at = await ev(`window.__refreshes`); await quiet(1800);
        check('a panel that is not showing is not read again', (await ev(`window.__refreshes`)) <= at + 1, `${at} then ${await ev('window.__refreshes')}`);
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Files watch checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
