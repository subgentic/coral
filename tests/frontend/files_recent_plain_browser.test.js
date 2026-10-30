// Files in a folder that is not a git repository (#10256, Mobile pass 17): an agent that wrote files there is not left with "Not a git folder". The answer carries the folder's recent files
// (is_git false): the panel lists them newest first under "Recent files", with no comparison picker, opens one as a plain file (no diff), and with none says an agent can share a file as an
// artifact. 390 and 1280 px; the route is stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SID = '0b2f6c1e-3d4a-4b5c-8d6e-000000010256';
const NAME = 'claude-' + SID;
const RECENT = [
    { filepath: 'old-notes.txt', status: '??', additions: 0, deletions: 0, recorded_at: '2026-10-27T09:00:00Z' },
    { filepath: 'out/report.md', status: '??', additions: 0, deletions: 0, recorded_at: '2026-10-28T09:00:00Z' },
    { filepath: 'data.csv', status: '??', additions: 0, deletions: 0, recorded_at: '2026-10-28T08:00:00Z' },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const stub = () => ev(`(() => { const R = window.fetch; window.__answer = 'recent'; window.__opened = [];
        const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (/\\/api\\/sessions\\/live\\/[^/]+\\/files(\\?|$)/.test(url)) return json({ files: window.__answer === 'recent' ? ${JSON.stringify(RECENT)} : [], diff_mode: 'branch_point', is_git: false });
            if (/\\/files\\/(content|preview|read)|[?&]path=/.test(url)) window.__opened.push(url);
            return R(u, o); }; return true; })()`);
    const load = () => ev(`(async () => { const m = await import(${MOD} + 'changed_files.js'); await m.loadChangedFiles(${JSON.stringify(NAME)}, ${JSON.stringify(SID)}); return true; })()`);
    const panel = () => ev(`(() => { const t = document.getElementById('changed-files-title'), l = document.getElementById('changed-files-list');
        return { title: t && t.textContent.replace(/\\s+/g, ' ').trim(), pickers: document.querySelectorAll('#agentic-panel-files select, #changed-files-title select').length, count: (document.getElementById('files-bar-count') || {}).textContent,
            rows: [...l.querySelectorAll('.file-item')].map(r => ({ path: r.dataset.filepath, diff: r.dataset.diff || '' })), text: l.textContent.replace(/\\s+/g, ' ').trim() }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await stub();
            await load();
            let p = await panel();
            assert.deepEqual(p.rows.map(r => r.path), ['out/report.md', 'data.csv', 'old-notes.txt'], `${w}: newest first: ${JSON.stringify(p)}`);
            assert.match(p.title, /^3 recent files/, `${w}: the header counts recent files, not changes: ${p.title}`);
            assert.doesNotMatch(p.title, /changed vs|HEAD/, `${w}: no comparison words`);
            assert.equal(p.pickers, 0, `${w}: no comparison picker`); assert.equal(p.count, '3');
            assert.ok(p.rows.every(r => r.diff === ''), `${w}: a plain folder's file opens as a file, not a diff: ${JSON.stringify(p.rows)}`);
            await ev(`window.__answer = 'none'; true`); await load();
            p = await panel();
            assert.equal(p.title, 'Not a git folder', `${w}: no recent files: the old title`);
            assert.match(p.text, /share a file with you as an artifact/, `${w}: the empty state says an agent can share an artifact: ${p.text}`);
        }
        console.log('PASS Files in a non-git folder: recent files newest first, a plain open, the artifact line when empty, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
