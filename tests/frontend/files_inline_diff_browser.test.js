// Inline diffs in the Files panel (#11350, the operator: "an inline expand for diffs ... a reviewer can expand all of their files and see an entire change"): each changed file's row has a chevron that opens its diff
// right under it (a read-only merge view collapsed to the changed hunks), Expand all stacks every file's diff in the list's order, Collapse all closes them. A binary file says so, a very long file's diff is read on
// request, and the preview pane is not opened by any of it. 1280 and 390 px. The panel's reads are answered in the page; Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const A_ORIG = ['package main', '', 'func a() int {', '\treturn 1', '}', ''].join('\n');
const A_CUR = ['package main', '', 'func a() int {', '\treturn 2 // changed in a', '}', ''].join('\n');
const LONG_ORIG = Array.from({ length: 4500 }, (_, i) => `line ${i}`).join('\n');
const LONG_CUR = LONG_ORIG.replace('line 2000', 'line 2000 CHANGED IN THE LONG FILE');
const FILES = {
    'a.go': { status: 'modified', original: A_ORIG, current: A_CUR, additions: 1, deletions: 1 },
    'b.txt': { status: 'added', original: '', current: 'a new file\nsecond line\n', additions: 2, deletions: 0 },
    'c.png': { status: 'modified', original: 'x', current: 'y', additions: 0, deletions: 0 },
    'd.log': { status: 'modified', original: LONG_ORIG, current: LONG_CUR, additions: 1, deletions: 1 },
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
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
                        if (f && /\\/file-content$/.test(p) && !(o && o.method === 'PUT')) return json({ content: f.current });
                        return R(u, o); }; })(); true`);
            await ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); st.state.currentSession = { type: 'live', name: 'wp', session_id: 'sid-wp', agent_type: 'claude' }; return true; })()`);
            await ev(`(async () => { const p = document.getElementById('agentic-panel-files'); window.switchAgenticTab('files'); for (let e = p; e && e !== document.body; e = e.parentElement) { e.hidden = false; e.classList.remove('hidden'); } return true; })()`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); await m.loadChangedFiles('wp', 'sid-wp'); return true; })()`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 4`, `${tag}: the four changed files`, 8000);
            const order = await ev(`[...document.querySelectorAll('#changed-files-list .file-item')].map(r => r.dataset.filepath)`);
            check(`${tag}: the list is in path order`, JSON.stringify(order) === JSON.stringify(['a.go', 'b.txt', 'c.png', 'd.log']), JSON.stringify(order));
            check(`${tag}: each row has a chevron and no diff is open`, await ev(`document.querySelectorAll('#changed-files-list .file-expand-btn[aria-expanded="false"]').length === 4 && [...document.querySelectorAll('#changed-files-list .file-diff')].every(d => d.hidden)`));
            check(`${tag}: the header offers Expand all`, (await ev(`(document.querySelector('#changed-files-list .files-expand-all') || {}).textContent`)) === 'Expand all');

            // expand one
            await ev(`document.querySelector('#changed-files-list .file-expand-btn[data-path="a.go"]').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-line')`, `${tag}: a.go's diff`, 8000);
            const one = await ev(`(() => { const d = document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"]'); return { text: d.innerText, shown: !d.hidden, others: [...document.querySelectorAll('#changed-files-list .file-diff')].filter(x => x !== d).every(x => x.hidden), expanded: document.querySelector('.file-expand-btn[data-path="a.go"]').getAttribute('aria-expanded'), next: d.previousElementSibling && d.previousElementSibling.dataset.filepath }; })()`);
            check(`${tag}: the diff is under its own row and says what changed`, one.shown && one.others && /return 2 \/\/ changed in a/.test(one.text) && one.expanded === 'true' && one.next === 'a.go', JSON.stringify(one));
            check(`${tag}: the preview pane was not opened`, await ev(`!document.querySelector('#preview-pane .cm-editor') && !document.querySelector('#preview-pane .preview-tab.active')`));

            // expand all
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="b.txt"] .cm-line') && !!document.querySelector('#changed-files-list .file-diff[data-filepath="d.log"] .file-diff-more')`, `${tag}: every diff is drawn`, 10000);
            const all = await ev(`(() => { const slots = [...document.querySelectorAll('#changed-files-list .file-diff')]; return { order: slots.map(s => s.dataset.filepath), shown: slots.every(s => !s.hidden), notes: Object.fromEntries(slots.map(s => [s.dataset.filepath, (s.querySelector('.file-diff-note') || {}).textContent || ''])), cm: slots.map(s => !!s.querySelector('.cm-line')), label: document.querySelector('#changed-files-list .files-expand-all').textContent, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
            check(`${tag}: every file's diff is stacked in the list's order`, JSON.stringify(all.order) === JSON.stringify(['a.go', 'b.txt', 'c.png', 'd.log']) && all.shown, JSON.stringify(all.order));
            check(`${tag}: a.go and b.txt have diffs, the binary and the long file have notes`, all.cm[0] && all.cm[1] && !all.cm[2] && !all.cm[3] && /binary file has no text diff/i.test(all.notes['c.png']) && /long file \(4,?500 lines\)/.test(all.notes['d.log']), JSON.stringify(all));
            check(`${tag}: the header now says Collapse all`, all.label === 'Collapse all', all.label);
            check(`${tag}: the page does not scroll sideways`, all.sideways <= 0, String(all.sideways));
            const added = await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="b.txt"]').innerText`);
            check(`${tag}: a new file's diff is all of it`, /a new file/.test(added) && /second line/.test(added), added);

            // the long file's diff on request
            await ev(`document.querySelector('#changed-files-list .file-diff-more').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="d.log"] .cm-line')`, `${tag}: the long file's diff on request`, 12000);
            check(`${tag}: the long file's change is shown`, /CHANGED IN THE LONG FILE/.test(await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="d.log"]').innerText`)));

            // collapse all
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`[...document.querySelectorAll('#changed-files-list .file-diff')].every(d => d.hidden)`, `${tag}: every diff closes`, 6000);
            check(`${tag}: Collapse all empties them and the chevrons say closed`, await ev(`[...document.querySelectorAll('#changed-files-list .file-diff')].every(d => d.children.length === 0) && [...document.querySelectorAll('.file-expand-btn')].every(b => b.getAttribute('aria-expanded') === 'false') && document.querySelector('#changed-files-list .files-expand-all').textContent === 'Expand all'`));

            // an open diff survives the list being drawn again
            await ev(`document.querySelector('#changed-files-list .file-expand-btn[data-path="a.go"]').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-line')`, `${tag}: a.go open again`, 8000);
            await ev(`window.__files['e.txt'] = { status: 'added', original: '', current: 'e\\n', additions: 1, deletions: 0 }; window.refreshChangedFiles().then(() => true)`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 5`, `${tag}: the list moved`, 8000);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-line')`, `${tag}: a.go's diff is drawn again after the list moved`, 8000);
            check(`${tag}: a diff that was open stays open when the list is drawn again`, await ev(`!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"]').hidden`));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the inline diffs:\n  ' + problems.join('\n  '));
    console.log('PASS inline diffs: expand one, expand all in order, collapse all');
})().catch(e => { console.error(e); process.exit(1); });
