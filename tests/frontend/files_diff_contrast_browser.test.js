// The Files panel's inline diffs: the text on an added (green) or removed (red) line stands out from its band (#12523, the operator: gray comment text on the green band looked washed out). Every coloured piece of
// text on a changed line, comments, keywords, strings, numbers and plain code, must reach WCAG AA (4.5:1) against what is behind it (the editor's background with the band over it), in the dark and the light theme, and
// the colours stay different from each other (the syntax is kept, not flattened to one colour). The panel's reads are answered in the page. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

const ORIG = ['package main', '', '// kept comment', 'func old() int {', '\treturn 1 // the old comment', '}', '', 'const name = "old string"', ''].join('\n');
const CUR = ['package main', '', '// kept comment', 'func fresh() int {', '\t// a new comment on an added line', '\treturn 42 // the new comment', '}', '', 'const name = "new string"', 'var count = 3.5', ''].join('\n');
const FILES = { 'a.go': { status: 'modified', original: ORIG, current: CUR, additions: 5, deletions: 3 } };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); window.__files = ${JSON.stringify(FILES)};
                (() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                        if (/\\/api\\/sessions\\/live\\/wp\\/files(\\/refresh)?$/.test(p)) return json({ files: Object.entries(window.__files).map(([filepath, f]) => ({ filepath, status: f.status, additions: f.additions, deletions: f.deletions })), is_git: true, compare: { label: 'HEAD' } });
                        const f = window.__files[String(url.searchParams.get('filepath') || '').replace(/^[/]+/, '')];
                        if (f && /\\/file-original$/.test(p)) return json({ content: f.original });
                        if (f && /\\/file-content$/.test(p) && !(o && o.method === 'PUT')) return json({ content: f.current });
                        return R(u, o); }; })(); true`);
            await ev(`window.__m.add('wp', 'A', 3, { sleeping: false }); true`);
            await ev(framesJs(30)); // the first live list renders from several answers: a few frames, no single completion event
            await ev(`window.selectLiveSession('wp', 'claude', 'wp-id', 'local'); true`);
            await waitFor(`!!document.getElementById('changed-files-title')`, `${theme}: the files panel`, 8000);
            await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`document.getElementById('changed-files-title').getClientRects().length > 0`, `${theme}: the Files header on screen`, 8000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'changed_files.js'); await m.loadChangedFiles('wp', 'wp-id'); return true; })()`);
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 1`, `${theme}: the changed file`, 8000);
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-changedLine') && !!document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"] .cm-deletedChunk')`, `${theme}: the diff is drawn with added and removed lines`, 10000);
            await ev(framesJs(10));
            const rows = await ev(`(() => {
                const parse = c => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
                const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat([1]); };
                const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
                const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
                const root = document.querySelector('#changed-files-list .file-diff[data-filepath="a.go"]');
                const behind = el => { const chain = []; for (let e = el; e && e !== root.parentElement; e = e.parentElement) chain.push(getComputedStyle(e).backgroundColor); let bg = [255, 255, 255, 1]; for (const c of chain.reverse()) { const p = parse(c); if (p[3] > 0) bg = over(p, bg); } return bg; };
                const out = [];
                for (const line of root.querySelectorAll('.cm-changedLine, .cm-deletedChunk, .cm-merge-b .cm-line:not(.cm-changedLine)')) {
                    const kind = line.matches('.cm-deletedChunk') ? 'removed' : line.matches('.cm-changedLine') ? 'added' : 'unchanged', walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
                    for (let t; (t = walker.nextNode());) { if (!t.nodeValue.trim()) continue; const el = t.parentElement, seen = parse(getComputedStyle(el).color), bg = behind(el); let k = 1; for (let e = el; e && e !== line.parentElement; e = e.parentElement) { const m = getComputedStyle(e).filter.match(/brightness\\(([\\d.]+)\\)/); if (m) k *= Number(m[1]); } /* a brightness() filter changes what is drawn, not the computed colour: apply it */ const fg = [0, 1, 2].map(i => Math.min(255, Math.round(seen[i] * k))); out.push({ kind, text: t.nodeValue.trim().slice(0, 28), color: 'rgb(' + fg.join(', ') + ')', ratio: Math.round(ratio(fg, bg) * 100) / 100 }); }
                }
                return out;
            })()`);
            const bad = rows.filter(r => r.ratio < 4.5);
            if (!rows.some(r => r.kind === 'added') || !rows.some(r => r.kind === 'removed') || !rows.some(r => r.kind === 'unchanged')) problems.push(`${theme}: no added, removed or unchanged text was measured: ${JSON.stringify(rows).slice(0, 300)}`);
            if (bad.length) problems.push(`${theme}: text under 4.5:1 on a diff line: ` + bad.map(r => `${r.kind} "${r.text}" ${r.color} ${r.ratio}`).join('; '));
            const colours = new Set(rows.filter(r => r.kind === 'added').map(r => r.color));
            if (colours.size < 3) problems.push(`${theme}: the syntax colours were flattened (${colours.size} different colours on the added lines): ${[...colours].join(' ')}`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('files_diff_contrast_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
