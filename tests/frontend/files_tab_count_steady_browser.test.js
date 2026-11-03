// The Files tab's number does not flash in and out (#12683, the Operator's screenshot). Two sources wrote it: the session feed's changed_file_count (what the agent's own Write and Edit calls changed, told on
// every update and cleared at 0) and the list the panel shows (the files git says differ, drawn every round of the watch); when they disagreed they took turns. While the Files panel shows, the list owns the number;
// the feed moves it when the panel is not showing; a number is written only when it changes. The badge is sampled by a MutationObserver across several rounds with an UNCHANGED list and a feed that disagrees. Drives Chrome over CDP.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the test samples the badge over time; the rounds are the thing observed
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.__coralFilesWatchMs = 400; true`);
        await ev(`(() => { const R = window.fetch; window.__refreshes = 0;
            const files = [{ filepath: 'a.txt', status: 'modified', additions: 1, deletions: 0 }, { filepath: 'b.txt', status: 'modified', additions: 1, deletions: 0 }, { filepath: 'c.txt', status: 'added', additions: 2, deletions: 0 }];
            const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = new URL(String(u), location.href);
                if (/\\/api\\/sessions\\/live\\/wp\\/files\\/refresh$/.test(url.pathname)) { window.__refreshes++; return json({ files, is_git: true, compare: { label: 'HEAD' } }); }
                if (/\\/api\\/sessions\\/live\\/wp\\/files$/.test(url.pathname)) return json({ files, is_git: true, compare: { label: 'HEAD' } });
                return R(u, o); }; return true; })()`);
        await ev(`import(${S} + 'state.js').then(st => { st.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude' }; return true; })`);
        const shown = await ev(`(async () => { const p = document.getElementById('agentic-panel-files'); if (!p) return 'no panel'; window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } } return p.classList.contains('active') && p.getClientRects().length > 0; })()`);
        check('the Files panel can be shown in this page', shown === true, String(shown));
        const feed = n => ev(`import(${S} + 'changed_files.js').then(m => { m.updateChangedFileCount(${n}); return true; })`);
        const badge = () => ev(`document.getElementById('files-bar-count').textContent`);
        await ev(`import(${S} + 'changed_files.js').then(m => { m.followChangedFiles({ session_id: 'sid-wp', name: 'wp', working: false, changed_file_count: 0 }); return true; })`);
        await waitFor(`document.getElementById('files-bar-count').textContent === '3'`, 'the list draws its number', 10000);
        check('the badge shows the list\'s count', (await badge()) === '3');

        // sample every value the badge takes while the feed keeps saying something else and the watch reads the same list again and again
        await ev(`window.__seen = [document.getElementById('files-bar-count').textContent]; window.__writes = 0;
            new MutationObserver(() => { window.__writes++; window.__seen.push(document.getElementById('files-bar-count').textContent); }).observe(document.getElementById('files-bar-count'), { childList: true, characterData: true, subtree: true }); true`);
        const rounds0 = await ev(`window.__refreshes`);
        for (let i = 0; i < 14; i++) { await feed(i % 2 ? 0 : 5); await quiet(450); } // the session feed: 0 (nothing the agent's tools changed), then 5
        const rounds = (await ev(`window.__refreshes`)) - rounds0;
        const seen = await ev(`[...new Set(window.__seen)]`);
        check('over several rounds of the watch the badge never leaves the list\'s count, whatever the feed says', JSON.stringify(seen) === '["3"]', `${rounds} rounds, values seen: ${JSON.stringify(seen)}`);
        check('and the watch really did read the list again in that time', rounds >= 2, String(rounds));
        check('nothing was written to it at all: a number is written only when it changes', (await ev(`window.__writes`)) === 0, String(await ev(`window.__writes`)));

        // not showing: the feed moves the number, as before; the same number again writes nothing
        await ev(`document.getElementById('agentic-panel-files').classList.remove('active'); true`);
        await feed(4);
        check('with the Files panel not showing the feed moves the number', (await badge()) === '4', await badge());
        await ev(`window.__writes = 0; true`);
        for (let i = 0; i < 8; i++) await feed(4);
        check('the same number again does not touch the badge', (await ev(`window.__writes`)) === 0, String(await ev(`window.__writes`)));
        await feed(0);
        check('a real 0 empties it', (await badge()) === '', JSON.stringify(await badge()));
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Files tab count checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
