// The Files panel's Compare select stays the same element while the panel redraws (#11658, the keyboard census flake: 'select "Compare" unreachable by Tab'): the header was rewritten whenever its text changed (a count, the
// server's comparison words arriving), which replaced the select: the census had tabbed to the old one and found the new one unreached, and a person with the list open or focused on it lost it to a poll. The count and the
// note change around it; the select (and its focus) stays; a change of the select's own options or choice still redraws it. Files route stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const SID = '0b2f6c1e-3d4a-4b5c-8d6e-000000011658', NAME = 'claude-' + SID, S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { window.__n = 1; window.__label = ''; const inner = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = String(url && url.url || url).replace(/^https?:\\/\\/[^/]+/, '');
                if (u.includes('/files')) return json({ files: Array.from({ length: window.__n }, (_, i) => ({ filepath: 'src/f' + i + '.go', status: 'M', additions: 2, deletions: 1 })), diff_mode: 'branch_point', ...(window.__label ? { compare: { label: window.__label } } : {}) });
                return inner(url, opts); }; return true; })()`);
        const load = () => ev(`(async () => { const m = await import(${S} + 'changed_files.js'); await m.loadChangedFiles(${JSON.stringify(NAME)}, ${JSON.stringify(SID)}); return true; })()`);
        await load();
        await waitFor(`!!document.querySelector('#changed-files-title .diff-mode-select')`, 'the Compare select is drawn', 8000);
        await ev(`(() => { for (const id of ['agentic-state', 'agentic-block-top', 'agentic-panel-files']) { const e = document.getElementById(id); e.hidden = false; e.style.setProperty('display', 'block', 'important'); } return true; })()`); // no agent is open here: the panel is shown by hand so the select can take focus
        await ev(`window.__sel = document.querySelector('#changed-files-title .diff-mode-select'); window.__sel.focus(); true`);
        const head = () => ev(`document.getElementById('changed-files-title').textContent.replace(/\\s+/g, ' ').trim()`);
        check(/^1 file changed/.test(await head()), 'one file is counted first: ' + await head());
        // the count changes
        await ev(`window.__n = 3; true`); await load();
        await waitFor(`/^3 files changed/.test(document.getElementById('changed-files-title').textContent.trim())`, 'the new count is drawn', 8000);
        check(await ev(`document.querySelector('#changed-files-title .diff-mode-select') === window.__sel`), 'a new count leaves the select the same element');
        check(await ev(`document.activeElement === window.__sel`), 'and the select keeps its focus');
        // the server's comparison words arrive
        await ev(`window.__label = 'Compared with the branch point (main is the current branch)'; true`); await load();
        await waitFor(`!!document.querySelector('#changed-files-title .files-compare-note')`, 'the comparison note is drawn', 8000);
        check(await ev(`document.querySelector('#changed-files-title .diff-mode-select') === window.__sel && document.activeElement === window.__sel`), 'the comparison note arriving leaves the select the same element, still focused');
        // the order of the header is as before: the count, the select, the note
        check(await ev(`(() => { const t = document.getElementById('changed-files-title'), at = cls => [...t.children].findIndex(c => c.classList.contains(cls)); return at('diff-mode-select') > at('changed-files-count') && at('files-compare-note') > at('diff-mode-select'); })()`), 'the header reads: count, select, note');
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('files_compare_select_stable_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
