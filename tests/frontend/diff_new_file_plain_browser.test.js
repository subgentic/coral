// A wholly added or removed file in the diff viewer has the plain line band and no word marks (#16171, the Operator: "what happened to our diff viewer?" and "the text shouldn't be highlighted like that"): the stronger
// word mark belongs to the words that changed inside a line, and a new file has every word changed, so the library drew a solid box behind every line's text (and per wrapped run) on top of the band. A modified line still
// marks only its changed words, and the text keeps its weight. Files panel inline diffs, 1440 and 390 px, dark and light. The panel's reads are answered in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const NEW_MD = ['# OpenCode v2 driver research for Coral', '', '**Date / tested build:** 2026-10-30, OpenCode CLI `v2.2.4` on macOS Darwin arm64. This is a docs-and-runtime investigation only; no Coral implementation changes were made.', '', '## Isolation and installation', '', 'All CLI/TUI work used `/tmp/opencode-research/home`, `/tmp/opencode-research/workspace`, and separate XDG config/data/cache/state directories under `/tmp/opencode-research`.', ''].join('\n');
const GONE = 'this file was deleted\nsecond line gone, with enough words to wrap on a phone and run past one line of the panel\n';
const MOD_ORIG = ['package main', '', 'func a() int {', '\treturn 1', '}', ''].join('\n');
const MOD_CUR = ['package main', '', 'func a() int {', '\treturn 2', '}', '', '// a block of lines', '// that is only added', ''].join('\n');
const FILES = {
    'new.md': { status: 'added', original: '', current: NEW_MD, additions: 8, deletions: 0 },
    'gone.txt': { status: 'deleted', original: GONE, current: null, additions: 0, deletions: 2 },
    'mod.go': { status: 'modified', original: MOD_ORIG, current: MOD_CUR, additions: 3, deletions: 1 },
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, theme] of [['1440 px dark', 1440, 900, false, 'dark'], ['1440 px light', 1440, 900, false, 'light'], ['390 px dark', 390, 844, true, 'dark'], ['390 px light', 390, 844, true, 'light']]) {
            const tag = label;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
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
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 3`, `${tag}: the three changed files`, 8000);
            await ev(`document.querySelector('#changed-files-list .files-expand-all').click(); true`);
            await waitFor(`['new.md', 'gone.txt', 'mod.go'].every(f => !!document.querySelector('#changed-files-list .file-diff[data-filepath="' + f + '"] .cm-line'))`, `${tag}: every diff is drawn`, 12000);
            await ev(`new Promise(r => setTimeout(r, 500)).then(() => true)`); // sleep-ok: the editors settle before they are read
            const m = await ev(`(() => { const d = f => document.querySelector('#changed-files-list .file-diff[data-filepath="' + f + '"]'), marks = (f, s) => [...d(f).querySelectorAll(s)].filter(e => { const b = getComputedStyle(e).backgroundColor; return b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent'; }).map(e => e.textContent); // a mark that draws a box
                const wt = f => [...d(f).querySelectorAll('.cm-changedLine span, .cm-deletedChunk span')].map(e => getComputedStyle(e).fontWeight);
                return { addMarks: marks('new.md', '.cm-changedText'), delMarks: marks('gone.txt', '.cm-deletedText, .cm-changedText'), modMarks: marks('mod.go', '.cm-changedText'), modDel: marks('mod.go', '.cm-deletedText'),
                    addLines: d('new.md').querySelectorAll('.cm-changedLine').length, delLines: d('gone.txt').querySelectorAll('.cm-deletedChunk').length, wAdd: [...new Set(wt('new.md'))], wDel: [...new Set(wt('gone.txt'))],
                    bg: d('new.md').querySelector('.cm-changedLine') && getComputedStyle(d('new.md').querySelector('.cm-changedLine')).backgroundColor }; })()`);
            check(`${tag}: a wholly added file has no word marks`, m.addMarks.length === 0, JSON.stringify(m.addMarks).slice(0, 200));
            check(`${tag}: a wholly removed file has no word marks`, m.delMarks.length === 0, JSON.stringify(m.delMarks).slice(0, 200));
            check(`${tag}: the added file still has its line band (${m.addLines} lines)`, m.addLines > 0 && m.bg && m.bg !== 'rgba(0, 0, 0, 0)', String(m.bg));
            check(`${tag}: the removed file still has its band`, m.delLines > 0);
            check(`${tag}: a modified line still marks only the word that changed, and the lines only added beside it have no box`, m.modMarks.length === 1 && m.modMarks[0] === '2', JSON.stringify(m.modMarks));
            if (label === '1440 px dark' || label === '390 px light' || label === '1440 px light' || label === '390 px dark') {
                await ev(`document.querySelector('#changed-files-list .file-diff[data-filepath="new.md"]').scrollIntoView({ block: 'start' }); true`);
                await ev(`new Promise(r => setTimeout(r, 200)).then(() => true)`); // sleep-ok: the scroll settles
                await shot('diff-new-file-' + label.replace(/ /g, '-'));
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'The diff viewer:\n  ' + problems.join('\n  '));
    console.log('PASS the diff viewer: a new or removed file has the plain band, a modified line marks only its changed words');
})().catch(e => { console.error(e); process.exit(1); });
