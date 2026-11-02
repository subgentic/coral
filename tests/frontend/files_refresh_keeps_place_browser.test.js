// The Files panel's changed-files list keeps the reader's place across its periodic refresh (#12520, the operator: "each periodic refresh redraws and loses scroll and open files"). With two files' diffs open, the panel
// scrolled down into the second and one of its collapsed "unchanged lines" blocks opened, a refresh that brings in one more file (the list moved) must leave: the same scroll position, both diffs open, the same editors
// (not drawn again from "Loading the changes…"), and the opened block still open. The panel's reads are answered in the page. 1280 px, and 390 px. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const A_ORIG = ['package main', '', 'func a() int {', '\treturn 1', '}', ''].join('\n');
const A_CUR = ['package main', '', 'func a() int {', '\treturn 2 // changed in a', '}', ''].join('\n');
const E_ORIG = Array.from({ length: 400 }, (_, i) => `func f${i}() int { return ${i} }`);
const E_CUR = E_ORIG.slice();
E_CUR[10] = 'func f10() int { return 1000 } // FIRST HUNK';
E_CUR[250] = 'func f250() int { return 2500 } // THIRD HUNK';
E_CUR[391] = 'func f391() int { return 3910 } // LAST HUNK';
const FILES = {
    'a.go': { status: 'modified', original: A_ORIG, current: A_CUR, additions: 1, deletions: 1 },
    'e.go': { status: 'modified', original: E_ORIG.join('\n'), current: E_CUR.join('\n'), additions: 3, deletions: 3 },
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 700, false], [390, 700, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__files = ${JSON.stringify(FILES)};
                (() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                        if (/\\/api\\/sessions\\/live\\/wp\\/files(\\/refresh)?$/.test(p)) return json({ files: Object.entries(window.__files).map(([filepath, f]) => ({ filepath, status: f.status, additions: f.additions, deletions: f.deletions })), is_git: true, compare: { label: 'HEAD' } });
                        const f = window.__files[String(url.searchParams.get('filepath') || '').replace(/^[/]+/, '')];
                        if (f && /\\/file-original$/.test(p)) return json({ content: f.original });
                        if (f && /\\/file-content$/.test(p) && !(o && o.method === 'PUT')) return f.current === null ? json({ error: 'not found' }) : json({ content: f.current });
                        return R(u, o); }; })(); true`);
            await ev(`window.__m.add('wp', 'A', 3, { sleeping: false }); true`);
            await waitFor(`!!window.selectLiveSession && !!document.querySelector('#session-list, #live-sessions, .session-item, [data-session-name]') || true`, `${tag}: the page is up`, 4000).catch(() => {});
            await ev(framesJs(30)); // the first live list renders from several answers: a few frames, no single completion event
            await ev(`window.selectLiveSession('wp', 'claude', 'wp-id', 'local'); true`);
            await waitFor(`!!document.getElementById('changed-files-title')`, `${tag}: the files panel`, 8000);
            await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`document.getElementById('changed-files-title').getClientRects().length > 0`, `${tag}: the Files header on screen`, 8000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); await m.loadChangedFiles('wp', 'wp-id'); return true; })()`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 2`, `${tag}: the two changed files`, 8000);
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .cm-line') && !!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-line')`, `${tag}: both diffs drawn`, 10000);
            // open one collapsed "unchanged lines" block in e.go and scroll the panel into it
            const blocks0 = await ev(`document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-collapsedLines').length`);
            check(`${tag}: e.go has collapsed unchanged blocks`, blocks0 >= 2, String(blocks0));
            await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .cm-collapsedLines').click(); true`);
            await ev(framesJs(4));
            await ev(`window.__sc = (() => { let e = document.getElementById('changed-files-list'); while (e && !(/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)) e = e.parentElement; return e; })(); window.__sc.scrollTop = Math.min(window.__sc.scrollHeight, 400); true`);
            await ev(framesJs(6));
            const before = await ev(`(() => ({ top: window.__sc.scrollTop, opened: ![...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-collapsedLines')].some(b => /^7 unchanged/.test(b.textContent.trim())), open: [...document.querySelectorAll('#changed-files-list .file-diff')].filter(d => !d.hidden).length, ed: (window.__ed = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"] .cm-editor')) && 1 }))()`);
            check(`${tag}: before the refresh the panel is scrolled, a block is open, two diffs are open`, before.top > 100 && before.opened && before.open === 2, JSON.stringify(before));
            // a refresh brings in one more file: the list is drawn again from what was read
            await ev(`window.__files['z.txt'] = { status: 'added', original: '', current: 'new\\n', additions: 1, deletions: 0 }; window.refreshChangedFiles(true).then(() => true)`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 3`, `${tag}: the refreshed list has three files`, 8000);
            await ev(framesJs(20));
            const after = await ev(`(() => { const e = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]'); return { top: window.__sc.scrollTop, opened: ![...e.querySelectorAll('.cm-collapsedLines')].some(b => /^7 unchanged/.test(b.textContent.trim())), open: [...document.querySelectorAll('#changed-files-list .file-diff')].filter(d => !d.hidden && d.dataset.filepath !== 'z.txt').length, sameEditor: e.querySelector('.cm-editor') === window.__ed, loading: !!document.querySelector('#changed-files-list .file-diff-note') }; })()`);
            check(`${tag}: the refresh keeps the scroll position`, Math.abs(after.top - before.top) <= 2, `${before.top} -> ${after.top}`);
            check(`${tag}: both open diffs are still open`, after.open === 2, JSON.stringify(after));
            check(`${tag}: the opened unchanged block is still open`, after.opened, JSON.stringify(after));
            check(`${tag}: the editors were not drawn again`, after.sameEditor && !after.loading, JSON.stringify(after));
            // a file that arrives ABOVE the reader moves the list, not the reader's place: the file under the top of the view stays where it was on the screen
            const y = () => ev(`(() => { const sc = window.__sc, top = sc.getBoundingClientRect().top; const row = [...document.querySelectorAll('#changed-files-list .file-item')].find(r => r.dataset.filepath === 'e.go'); return Math.round(row.getBoundingClientRect().top - top); })()`);
            const y0 = await y();
            await ev(`window.__files['b.txt'] = { status: 'added', original: '', current: 'new\\n', additions: 1, deletions: 0 }; window.refreshChangedFiles(true).then(() => true)`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 4`, `${tag}: the list has four files`, 8000);
            await ev(framesJs(20));
            const y1 = await y();
            check(`${tag}: a file arriving above does not move the content the reader is on`, Math.abs(y1 - y0) <= 2, `${y0} -> ${y1}`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('files_refresh_keeps_place_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
