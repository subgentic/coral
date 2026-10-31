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
// 400 lines with four changes spread through it: its collapsed diff is taller than any box would be, and its last hunk must be reachable by scrolling the panel (the Mobile Beta Tester's walk)
const E_ORIG = Array.from({ length: 400 }, (_, i) => `func f${i}() int { return ${i} }`);
const E_CUR = E_ORIG.slice();
E_CUR[10] = 'func f10() int { return 1000 } // FIRST HUNK';
E_CUR[120] = 'func f120() int { return 1200 } // SECOND HUNK';
E_CUR[250] = 'func f250() int { return 2500 } // THIRD HUNK';
E_CUR[391] = 'func f391() int { return 3910 } // LAST HUNK with a long line that wraps on a phone and runs to the panel edge on a desktop, to see the room it has on its right';
const FILES = {
    'a.go': { status: 'modified', original: A_ORIG, current: A_CUR, additions: 1, deletions: 1 },
    'b.txt': { status: 'added', original: '', current: 'a new file\nsecond line\n', additions: 2, deletions: 0 },
    'c.png': { status: 'modified', original: 'x', current: 'y', additions: 0, deletions: 0 },
    'd.log': { status: 'modified', original: LONG_ORIG, current: LONG_CUR, additions: 1, deletions: 1 },
    'e.go': { status: 'modified', original: E_ORIG.join('\n'), current: E_CUR.join('\n'), additions: 4, deletions: 4 },
    'f.txt': { status: 'deleted', original: 'this file was deleted\nsecond line gone\n', current: null, additions: 0, deletions: 2 },
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, zoom] of [[1280, 900, false, ''], [390, 844, true, ''], [390, 844, true, '32px']]) {
            const tag = `${w} px${zoom ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            if (zoom) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
            await ev(`window.__files = ${JSON.stringify(FILES)};
                (() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                        if (/\\/api\\/sessions\\/live\\/wp\\/files(\\/refresh)?$/.test(p)) return json({ files: Object.entries(window.__files).map(([filepath, f]) => ({ filepath, status: f.status, additions: f.additions, deletions: f.deletions })), is_git: true, compare: { label: 'HEAD' } });
                        const f = window.__files[String(url.searchParams.get('filepath') || '').replace(/^[/]+/, '')];
                        if (f && /\\/file-original$/.test(p)) return json({ content: f.original });
                        if (f && /\\/file-content$/.test(p) && !(o && o.method === 'PUT')) return f.current === null ? json({ error: 'not found' }) : json({ content: f.current });
                        return R(u, o); }; })(); true`);
            await ev(`window.__m.add('wp', 'A', 3, { sleeping: false }); true`);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
            await ev(`window.selectLiveSession('wp', 'claude', 'wp-id', 'local'); true`);
            await waitFor(`!!document.getElementById('changed-files-title')`, `${tag}: the files panel`, 8000);
            await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`document.getElementById('changed-files-title').getClientRects().length > 0`, `${tag}: the Files header on screen`, 8000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); await m.loadChangedFiles('wp', 'wp-id'); return true; })()`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 6`, `${tag}: the six changed files`, 8000);
            const order = await ev(`[...document.querySelectorAll('#changed-files-list .file-item')].map(r => r.dataset.filepath)`);
            check(`${tag}: the list is in path order`, JSON.stringify(order) === JSON.stringify(['a.go', 'b.txt', 'c.png', 'd.log', 'e.go', 'f.txt']), JSON.stringify(order));
            check(`${tag}: each row has a chevron and no diff is open`, await ev(`document.querySelectorAll('#changed-files-list .file-expand-btn[aria-expanded="false"]').length === 6 && [...document.querySelectorAll('#changed-files-list .file-diff')].every(d => d.hidden)`));
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
            check(`${tag}: every file's diff is stacked in the list's order`, JSON.stringify(all.order) === JSON.stringify(['a.go', 'b.txt', 'c.png', 'd.log', 'e.go', 'f.txt']) && all.shown, JSON.stringify(all.order));
            check(`${tag}: a.go and b.txt have diffs, the binary and the long file have notes`, all.cm[0] && all.cm[1] && !all.cm[2] && !all.cm[3] && all.cm[4] && all.cm[5] && /binary file has no text diff/i.test(all.notes['c.png']) && /long file \(4,?500 lines\)/.test(all.notes['d.log']), JSON.stringify(all));
            check(`${tag}: the header now says Collapse all`, all.label === 'Collapse all', all.label);
            check(`${tag}: the page does not scroll sideways`, all.sideways <= 0, String(all.sideways));
            const added = await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="b.txt"]').innerText`);
            check(`${tag}: a new file's diff is all of it`, /a new file/.test(added) && /second line/.test(added), added);

            // a 400-line file with four hunks: its last one is reachable by scrolling the panel (no box of its own), and its long line stops short of the panel's edge
            // the editor draws the lines that are in view as the panel scrolls: scroll the panel to the end of this file's diff, then the last hunk is there
            await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]').scrollIntoView({ block: 'end' }); true`);
            await waitFor(`[...document.querySelectorAll('#changed-files-list .file-diff[data-filepath="e.go"] .cm-line')].some(l => /LAST HUNK/.test(l.textContent))`, `${tag}: the last hunk is drawn once the panel is scrolled to it`, 8000).catch(() => {});
            const last = await ev(`(() => { const slot = document.querySelector('#changed-files-list .file-diff[data-filepath="e.go"]'), line = [...slot.querySelectorAll('.cm-line')].find(l => /LAST HUNK/.test(l.textContent)); if (!line) return { found: false, text: slot.innerText.slice(-200) }; line.scrollIntoView({ block: 'center' }); const r = line.getBoundingClientRect(), d = slot.getBoundingClientRect(); const body = slot.querySelector('.file-diff-body'); return { found: true, inView: r.top < innerHeight && r.bottom > 0 && (r.top >= 0 || r.bottom - r.top > innerHeight), noBox: body.scrollHeight - body.clientHeight <= 1, edge: Math.round(d.right - r.right), hunks: slot.innerText.includes('LAST HUNK') }; })()`);
            check(`${tag}: the last hunk of a 400-line file is there, in a diff with no scroll box, and the panel scrolls it into view`, last.found && last.inView && last.noBox && last.hunks, JSON.stringify(last));
            check(`${tag}: its long line stops short of the panel's edge`, last.found && last.edge >= 0, JSON.stringify(last));
            const gone = await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="f.txt"]').innerText`);
            check(`${tag}: a deleted file's diff shows what was removed`, /this file was deleted/.test(gone) && /second line gone/.test(gone), gone);

            // the long file's diff on request
            await ev(`document.querySelector('#changed-files-list .file-diff-more').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="d.log"] .cm-line')`, `${tag}: the long file's diff on request`, 12000);
            check(`${tag}: the long file's change is shown`, /CHANGED IN THE LONG FILE/.test(await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="d.log"]').innerText`)));

            // no diff is a scroll box of its own: the stack reads top to bottom in the panel's scroll
            const boxes = await ev(`[...document.querySelectorAll('#changed-files-list .file-diff-body')].map(b => { const sc = b.querySelector('.cm-scroller'); return { box: b.scrollHeight - b.clientHeight, scroller: sc ? sc.scrollHeight - sc.clientHeight : 0, edge: (() => { const d = b.closest('.file-diff').getBoundingClientRect(), l = [...b.querySelectorAll('.cm-line')].reduce((m, x) => Math.max(m, x.getBoundingClientRect().right), 0); return Math.round(d.right - l); })() }; })`);
            check(`${tag}: no diff scrolls inside a box of its own, and the lines stop short of the panel's edge`, boxes.length >= 3 && boxes.every(b => b.box <= 1 && b.scroller <= 1 && b.edge >= 0), JSON.stringify(boxes));

            // collapse all
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`[...document.querySelectorAll('#changed-files-list .file-diff')].every(d => d.hidden)`, `${tag}: every diff closes`, 6000);
            check(`${tag}: Collapse all empties them and the chevrons say closed`, await ev(`[...document.querySelectorAll('#changed-files-list .file-diff')].every(d => d.children.length === 0) && [...document.querySelectorAll('.file-expand-btn')].every(b => b.getAttribute('aria-expanded') === 'false') && document.querySelector('#changed-files-list .files-expand-all').textContent === 'Expand all'`));

            // an open diff survives the list being drawn again
            await ev(`document.querySelector('#changed-files-list .file-expand-btn[data-path="a.go"]').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-line')`, `${tag}: a.go open again`, 8000);
            await ev(`window.__files['g.txt'] = { status: 'added', original: '', current: 'e\\n', additions: 1, deletions: 0 }; window.refreshChangedFiles().then(() => true)`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 7`, `${tag}: the list moved`, 8000);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-line')`, `${tag}: a.go's diff is drawn again after the list moved`, 8000);
            check(`${tag}: a diff that was open stays open when the list is drawn again`, await ev(`!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"]').hidden`));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the inline diffs:\n  ' + problems.join('\n  '));
    console.log('PASS inline diffs: expand one, expand all in order, collapse all');
})().catch(e => { console.error(e); process.exit(1); });
