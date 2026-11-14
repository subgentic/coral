// The Files panel's diff gutter follows the theme (#16366, the Beta Tester's chat walk #16341 on v2.0.68: on an added file in the dark theme the line-number gutter stayed a bright light-grey column beside dark rows). Added, removed and modified files, 1440 and 390 px, dark and light: the gutter is the editor's own colour, not a lighter or darker band, and its numbers read on it (3:1). The panel's reads are answered in the page.
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
            const m = await ev(`(() => { const rgb = c => c.match(/[\\d.]+/g).map(Number); const lum = c => { const [r, g, b] = rgb(c).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
                const eff = el => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor; if (rgb(c).length < 4 || rgb(c)[3] > 0.5) return c; } return 'rgb(255,255,255)'; };
                const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
                const out = {}; for (const f of ['new.md', 'gone.txt', 'mod.go']) { const d = document.querySelector('#changed-files-list .file-diff[data-filepath="' + f + '"]'), gut = d.querySelector('.cm-gutters'), num = d.querySelector('.cm-lineNumbers .cm-gutterElement:not([style*="height: 0"])') || gut, ed = d.querySelector('.cm-scroller');
                    const gutBg = eff(gut), edBg = eff(d.querySelector('.cm-content')); out[f] = { gutBg, edBg, gutLum: lum(gutBg), edLum: lum(edBg), numContrast: ratio(getComputedStyle(num).color, gutBg) }; } return out; })()`);
            await shot(`gutter-${label.replace(/ /g, '-')}`);
            console.log(tag, JSON.stringify(m));
            for (const [f, g] of Object.entries(m)) {
                check(`${tag}: ${f}: the gutter is the editor's own colour, not a lighter or darker band`, Math.abs(g.gutLum - g.edLum) < 0.05, JSON.stringify(g));
                check(`${tag}: ${f}: the line numbers read on the gutter (3:1)`, g.numContrast >= 3, JSON.stringify(g));
            }
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS the diff gutter follows the theme');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
