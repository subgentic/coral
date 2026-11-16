// The Files panel's search box (#17632 moved it into a lazy module; QA3 found its arrow keys threw): typing lists the matching files, Down and Up move the highlight, Enter opens the highlighted file in the preview, and a path
// that is not there offers + Create. Real key events on a stubbed file list, 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SID = '0b2f6c1e-3d4a-4b5c-8d6e-000000010269';
const NAME = 'claude-' + SID;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const { Input } = client;
    const KEYS = { ArrowDown: 40, ArrowUp: 38, Enter: 13 };
    const press = async k => { const o = { key: k, code: k, windowsVirtualKeyCode: KEYS[k], ...(k === 'Enter' ? { text: '\r' } : {}) }; await Input.dispatchKeyEvent({ type: k === 'Enter' ? 'keyDown' : 'rawKeyDown', ...o }); await Input.dispatchKeyEvent({ type: 'keyUp', ...o }); await new Promise(r => setTimeout(r, 150)); }; // sleep-ok: the handler runs
    const problems = [], check = (ok, m) => { if (!ok) problems.push(m); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (/\\/api\\/sessions\\/live\\/[^/]+\\/files(\\?|$)/.test(url)) return json({ files: [], diff_mode: 'branch_point', is_git: false });
                if (/\\/search-files\\?/.test(url)) return json({ files: ['src/alpha.js', 'src/alpine.js', 'docs/readme.md'] });
                return R(u, o); }; window.__errors = []; addEventListener('error', e => window.__errors.push(String(e.message))); addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason))); return true; })()`);
        await ev(`(async () => { const st = (await import(${MOD} + 'state.js')).state; st.currentSession = { type: 'live', name: ${JSON.stringify(NAME)}, session_id: ${JSON.stringify(SID)} };
            const m = await import(${MOD} + 'changed_files.js'); await m.loadChangedFiles(${JSON.stringify(NAME)}, ${JSON.stringify(SID)}); m.initFileSearch(); return true; })()`);
        await ev(`(async () => { const p = document.getElementById('agentic-panel-browse'); if (!p) return 'no panel'; window.switchAgenticTab('browse'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('collapsed'); if (getComputedStyle(e).display === 'none') e.style.setProperty('display', 'block', 'important'); if (!e.offsetWidth || !e.offsetHeight) { e.style.minWidth = '300px'; e.style.minHeight = '200px'; e.style.position = 'relative'; } } return true; })()`);
        await waitFor(`!!document.getElementById('files-search-input') && document.getElementById('files-search-input').getClientRects().length > 0`, 'the search box', 5000);
        await ev(`(() => { const i = document.getElementById('files-search-input'); i.focus(); i.value = 'src/al'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('#files-search-dropdown .file-mention-item').length === 3`, 'two matches and + Create in the dropdown', 5000, `({ n: document.querySelectorAll('#files-search-dropdown .file-mention-item').length, d: (document.getElementById('files-search-dropdown')||{}).style && document.getElementById('files-search-dropdown').style.display, errs: window.__errors, mod: performance.getEntriesByType('resource').some(e => /file_search/.test(e.name)) })`);
        const sel = () => ev(`[...document.querySelectorAll('#files-search-dropdown .file-mention-item')].findIndex(e => e.classList.contains('selected'))`);
        check(await sel() === 0, 'the first match is highlighted: ' + await sel());
                await press('ArrowDown'); check(await sel() === 1, 'Down moves the highlight: ' + await sel());
        await press('ArrowUp'); check(await sel() === 0, 'Up moves it back: ' + await sel());
        check((await ev(`window.__errors`)).length === 0, 'the arrow keys threw: ' + JSON.stringify(await ev(`window.__errors`)));
        await press('ArrowDown'); check(await sel() === 1, 'Down again: ' + await sel()); await press('Enter');
        try { await waitFor(`(document.querySelector('#preview-toolbar .preview-toolbar-path') || {}).textContent === 'src/alpine.js'`, 'the file open in the preview', 3000); } catch (e) { problems.push(e.message.slice(0, 200)); }
        check(true, '');
        await ev(`(() => { const i = document.getElementById('files-search-input'); i.focus(); i.value = 'src/new.js'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`[...document.querySelectorAll('#files-search-dropdown .file-mention-item')].some(e => /^\\+ Create src\\/new\\.js$/.test(e.textContent))`, 'the + Create row', 5000);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Files search:\n  ' + problems.join('\n  '));
    console.log('PASS the Files search: typing lists matches, Down and Up move the highlight, Enter opens the file, a new path offers + Create');
})().catch(e => { console.error(e.message); process.exit(1); });
