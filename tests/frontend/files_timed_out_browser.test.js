// A refresh whose git ran out of time (the server answers timed_out: true) says so in the Files panel, with Refresh, and keeps the last list when there is one: it never says "0 files changed" or "No changed files" for a list that
// was not read. Drives Chrome over CDP; the routes are stood in at the page's fetch.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const text = () => ev(`document.getElementById('changed-files-list').textContent.replace(/\\s+/g, ' ')`);
    const title = () => ev(`document.getElementById('changed-files-title').textContent.replace(/\\s+/g, ' ')`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.__coralFilesWatchMs = 500; true`);
        // mode: 'ok' answers a normal list; 'keep' answers timed_out with the last list; 'none' answers timed_out with nothing
        await ev(`(() => { const R = window.fetch; window.__mode = 'keep'; window.__calls = [];
            const files = [{ filepath: 'a.txt', status: 'modified', additions: 1, deletions: 0 }, { filepath: 'b.txt', status: 'modified', additions: 1, deletions: 0 }];
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const body = () => window.__mode === 'ok' ? { files, is_git: true, compare: { label: 'HEAD' }, total_changed: 2, timed_out: false }
                    : window.__mode === 'keep' ? { files, is_git: true, compare: { label: 'HEAD' }, total_changed: 2, timed_out: true }
                    : { files: [], is_git: true, compare: { label: 'HEAD' }, total_changed: 0, timed_out: true };
                if (/\\/api\\/sessions\\/live\\/wt\\/files\\/refresh$/.test(url.pathname)) { window.__calls.push(url.search); return json(body()); }
                if (/\\/api\\/sessions\\/live\\/wt\\/files$/.test(url.pathname)) return json(body());
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'wt', session_id: 'sid-wt', agent_type: 'claude' }; return true; })()`);
        await ev(`(async () => { const p = document.getElementById('agentic-panel-files'); if (!p) return 'no panel'; window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } } return true; })()`);
        const follow = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); m.followChangedFiles({ session_id: 'sid-wt', name: 'wt', working: false, changed_file_count: 0 }); return true; })()`);

        // 1. timed out with a last list: the note, the list kept, no "0 files changed"
        await follow();
        await waitFor(`/Git took too long on this folder/.test(document.getElementById('changed-files-list').textContent)`, 'the timed out note', 6000);
        let t = await text(), h = await title();
        check('a timed out pass says so', /Git took too long on this folder; showing the last list\./.test(t), t.slice(0, 160));
        check('and has a Refresh button', (await ev(`[...document.querySelectorAll('#changed-files-list .files-timedout-note button')].map(b => b.textContent.trim()).join('|')`)) === 'Refresh');
        check('the last list is still shown', /a\.txt/.test(t) && /b\.txt/.test(t), t.slice(0, 160));
        check('the header says how many, not 0', /2 files changed/.test(h), h.slice(0, 100));

        // 2. timed out with nothing to keep: the note and no "0 files changed" and no "No changed files"
        await ev(`window.__mode = 'none'; document.querySelector('#changed-files-list .files-timedout-note button').click(); true`);
        await waitFor(`!/a\\.txt/.test(document.getElementById('changed-files-list').textContent)`, 'the empty timed out answer', 6000);
        t = await text(); h = await title();
        check('with no last list the note is still there', /Git took too long on this folder; showing the last list\./.test(t), t.slice(0, 160));
        check('it does not say "No changed files"', !/No changed files/.test(t), t.slice(0, 160));
        check('the header does not say "0 files changed"', !/0 files changed/.test(h), h.slice(0, 100));

        // 3. a pass that finishes clears the note
        await ev(`window.__mode = 'ok'; document.querySelector('#changed-files-list .files-timedout-note button').click(); true`);
        await waitFor(`!/Git took too long/.test(document.getElementById('changed-files-list').textContent)`, 'the note goes', 6000);
        check('the next pass that finishes takes the note away', true);
        check('and the list is back', /a\.txt/.test(await text()));
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} timed-out checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
