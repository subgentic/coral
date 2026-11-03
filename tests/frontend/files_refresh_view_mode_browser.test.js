// Through the Coral Hub on a computer in View mode the Files panel's refresh (a POST, an Interact route) is refused 403 access_mode and leaves an audit row each time; the watch asked about every 2 s for as
// long as the panel showed (#12646, coral-hub's beta pass). A view of a remote '@srv1' computer asks ONCE and then reads the cached list (a GET), and says once, quietly, that the list may be out of date; a
// page that already knows the computer is in View mode (its cached access) does not ask at all; the access changing, or the panel closing and showing again, asks again. Drives Chrome over CDP.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = (refusal) => `(() => { const R = window.fetch; window.__posts = 0; window.__gets = 0;
    window.__refusal = ${JSON.stringify(refusal)};
    window.fetch = (u, o) => { const url = new URL(String(u), location.href), method = (o && o.method) || 'GET';
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
        if (/\\/files\\/refresh$/.test(url.pathname) && method === 'POST') { window.__posts++; return window.__refusal ? json(window.__refusal, 403) : json({ files: [], is_git: true, compare: { label: 'HEAD' } }); }
        if (/\\/sessions\\/live\\/[^/]+\\/files$/.test(url.pathname)) { window.__gets++; return json({ files: [{ filepath: 'cached.txt', status: 'modified', additions: 1, deletions: 0 }], is_git: true, compare: { label: 'HEAD' } }); }
        if (url.pathname === '/api/servers') return json({ servers: window.__servers || [] });
        return R(u, o); }; return true; })()`;

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the test shows that nothing more is asked in this time, which only waiting can show
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const open = async (refusal, servers) => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.__coralFilesWatchMs = 400; window.__servers = ${JSON.stringify(servers || [])}; true`);
        await ev(STUB(refusal));
        if (servers) await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'server_access.js'); await m.serverAccess('srv1'); return true; })()`);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude', server: 'srv1' }; return true; })()`);
        const shown = await ev(`(async () => { const p = document.getElementById('agentic-panel-files'); if (!p) return 'no panel'; window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } } return p.classList.contains('active') && p.getClientRects().length > 0; })()`);
        check('the Files panel can be shown in this page', shown === true, String(shown));
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles({ session_id: 'sid-wp', name: 'wp', server: 'srv1', working: false, changed_file_count: 0 }); return true; })()`);
    };
    const note = () => ev(`[...document.querySelectorAll('#changed-files-list .files-stale-note')].map(e => e.textContent)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        // 1. the first refresh is refused 403 limited by the Hub: one POST, then none, and the cached list is read
        await open({ error: 'access_mode', limited_by: 'hub', hub_mode: 'view', local_mode: 'interact', required: 'interact' });
        await waitFor(`window.__posts >= 1`, 'the watch asks once', 8000);
        await waitFor(`/cached\\.txt/.test(document.getElementById('changed-files-list').textContent)`, 'the cached list is drawn', 8000);
        await quiet(5500); // three more rounds of the 2 s watch
        const after = await ev(`({ posts: window.__posts, gets: window.__gets })`);
        check('after a 403 for the mode the view asks for the refresh once and never again', after.posts === 1, JSON.stringify(after));
        check('it reads the cached list instead', after.gets >= 2, JSON.stringify(after));
        const n = await note();
        check('it says once, quietly, that the list may be out of date', n.length === 1 && /View mode/.test(n[0]) && /out of date/.test(n[0]), JSON.stringify(n));
        check('the note is not a live region (it is not announced again and again)', await ev(`!document.querySelector('#changed-files-list .files-stale-note').closest('[aria-live], [role="status"], [role="alert"]')`));

        // the panel closes and shows again: it asks once more (reopening), and is refused once more
        await ev(`document.getElementById('agentic-panel-files').classList.remove('active'); true`);
        await quiet(1200);
        await ev(`window.switchAgenticTab('files'); (async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles({ session_id: 'sid-wp', name: 'wp', server: 'srv1', working: false, changed_file_count: 0 }); })(); true`);
        await waitFor(`window.__posts >= 2`, 'reopening asks again', 8000);
        await quiet(3000);
        check('reopening asks again, once', (await ev(`window.__posts`)) === 2, String(await ev(`window.__posts`)));

        // 2. the page already knows the computer is in View mode: it never asks
        await open(null, [{ id: 'srv1', label: 'srv1', access_mode: 'view', hub_mode: 'view', local_mode: 'interact', effective_mode: 'view', limited_by: 'hub' }]);
        await waitFor(`window.__gets >= 2`, 'the cached list is read', 8000);
        await quiet(2500);
        check('a page that knows View mode makes no refresh POST at all', (await ev(`window.__posts`)) === 0, String(await ev(`window.__posts`)));
        check('and shows the cached list and the note', /cached\.txt/.test(await ev(`document.getElementById('changed-files-list').textContent`)) && (await note()).length === 1);

        // 3. a computer with Interact is asked as before, and shows no note
        await open(null, [{ id: 'srv1', label: 'srv1', access_mode: 'interact', hub_mode: 'interact', local_mode: 'interact', effective_mode: 'interact' }]);
        await waitFor(`window.__posts >= 1`, 'an Interact computer is asked', 8000);
        check('an Interact computer is refreshed as before, with no note', (await note()).length === 0);

        // 4. a 403 that is not about the access mode (the page's CSRF check, a lost session, a plain refusal) does not stop the refreshes: they go on being asked
        for (const [label, refusal] of [['a CSRF refusal', { error: 'forbidden' }], ['a 403 with no body', ''], ['a 403 of another word', { error: 'owner_only' }]]) {
            await open(refusal, undefined);
            await waitFor(`window.__posts >= 3`, `${label}: the watch keeps asking`, 14000);
            check(`${label} does not block the refresh: it is asked again and again`, (await ev(`window.__posts`)) >= 3 && (await note()).length === 0, String(await ev(`window.__posts`)));
        }

        // 5. a view blocked for the mode asks again for ANOTHER agent, and for the same agent on ANOTHER computer (the block belongs to one view)
        const blocked = async () => { await open({ error: 'access_mode', limited_by: 'hub', hub_mode: 'view' }); await waitFor(`window.__posts === 1 && /View mode/.test((document.querySelector('#changed-files-list .files-stale-note') || {}).textContent || '')`, 'the view is blocked', 10000); await ev(`window.__refusal = null; true`); };
        const refreshNow = () => ev(`Promise.resolve(window.refreshChangedFiles(true)).then(() => true)`); // the window entry a person's click reaches
        await blocked();
        await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.currentSession = { type: 'live', name: 'wp2', session_id: 'sid-wp2', agent_type: 'claude', server: 'srv1' }; return true; })`);
        await refreshNow();
        check('another agent on the same computer is asked again (the block is the first view\'s)', (await ev(`window.__posts`)) === 2, String(await ev(`window.__posts`)));
        await blocked();
        await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude', server: 'srv2' }; return true; })`);
        await refreshNow();
        check('the same agent on another computer is asked again', (await ev(`window.__posts`)) === 2, String(await ev(`window.__posts`)));
        await blocked();
        await refreshNow(); await refreshNow();
        check('the view that was refused stays blocked while nothing changed (no POST for a manual refresh either)', (await ev(`window.__posts`)) === 1, String(await ev(`window.__posts`)));

        // 6. the access the page knows turning Interact lifts the block
        await blocked();
        await ev(`window.__servers = [{ id: 'srv1', label: 'srv1', access_mode: 'interact', hub_mode: 'interact', local_mode: 'interact', effective_mode: 'interact' }]; import((window.__coralStatic || '/static/') + 'server_access.js').then(async m => { m.invalidateServerAccess(); await m.serverAccess('srv1'); return true; })`);
        await refreshNow();
        check('a cached access that now allows Interact lifts the block: the refresh is asked again, and the note goes', (await ev(`window.__posts`)) === 2 && (await note()).length === 0, `${await ev('window.__posts')} ${JSON.stringify(await note())}`);
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Files refresh View-mode checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
