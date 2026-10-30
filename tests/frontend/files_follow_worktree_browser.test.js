// The Files panel follows an agent into the git worktree it works in (#11351, the operator): the list is read with worktree=follow, the panel names the worktree and its branch and offers "Back to launch folder";
// the way back reads the launch folder's list (worktree=launch) and offers "Follow it"; every file read the panel and its inline diffs make carries the same choice. The server's answers are stubbed in the page.
// 1280 and 390 px. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

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
            await ev(`window.__reads = [];
                (() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname, mode = url.searchParams.get('worktree');
                        if (/\\/api\\/sessions\\/live\\/wp\\/files(\\/refresh)?$/.test(p)) {
                            window.__reads.push({ path: p.replace(/.*live\\/wp\\//, ''), mode });
                            const wt = { path: '/work/feature-tree', name: 'feature-tree', branch: 'feature', followed: mode === 'follow', launch: '/work/main-repo' };
                            return json({ files: mode === 'follow' ? [{ filepath: 'work.txt', status: 'added', additions: 2, deletions: 0 }] : [{ filepath: 'launch.txt', status: 'modified', additions: 1, deletions: 1 }], is_git: true, compare: { label: 'HEAD' }, worktree: wt }); }
                        if (/\\/(file-content|file-original)$/.test(p)) { window.__reads.push({ path: p.replace(/.*live\\/wp\\//, ''), mode }); return json({ content: p.endsWith('original') ? '' : 'the agent work\\n' }); }
                        return R(u, o); }; })(); true`);
            await ev(`window.__m.add('wp', 'A', 3, { sleeping: false }); true`);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
            await ev(`window.selectLiveSession('wp', 'claude', 'wp-id', 'local'); true`);
            await waitFor(`!!document.getElementById('changed-files-title')`, `${tag}: the files panel`, 8000);
            await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); true`);
            await waitFor(`document.getElementById('changed-files-title').getClientRects().length > 0`, `${tag}: the Files header on screen`, 8000);
            await ev(`window.refreshChangedFiles().then(() => true)`);
            await waitFor(`!!document.querySelector('#changed-files-list .files-worktree')`, `${tag}: the worktree is named`, 8000);

            const first = await ev(`({ note: document.querySelector('#changed-files-list .files-worktree').innerText, files: [...document.querySelectorAll('#changed-files-list .file-item')].map(r => r.dataset.filepath), reads: window.__reads })`);
            check(`${tag}: the panel follows by default and names the worktree and its branch`, /Following the agent in the worktree/.test(first.note) && /feature-tree/.test(first.note) && /feature/.test(first.note) && /Back to launch folder/.test(first.note), first.note);
            check(`${tag}: the worktree's file is listed`, JSON.stringify(first.files) === JSON.stringify(['work.txt']), JSON.stringify(first.files));
            check(`${tag}: the list was read with worktree=follow`, first.reads.length > 0 && first.reads.every(r => r.mode === 'follow'), JSON.stringify(first.reads));

            // an inline diff reads the same folder
            await ev(`window.__reads = []; document.querySelector('#changed-files-list .file-expand-btn').click(); true`);
            await waitFor(`window.__reads.some(r => /file-content/.test(r.path))`, `${tag}: the diff is read`, 8000);
            check(`${tag}: a diff's file reads carry worktree=follow`, (await ev(`window.__reads`)).every(r => r.mode === 'follow'), JSON.stringify(await ev(`window.__reads`)));

            // the way back
            await ev(`window.__reads = []; document.querySelector('#changed-files-list [data-on-click="worktree-launch"]').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list [data-on-click="worktree-follow"]')`, `${tag}: the way back is taken`, 8000);
            const back = await ev(`({ note: document.querySelector('#changed-files-list .files-worktree').innerText, files: [...document.querySelectorAll('#changed-files-list .file-item')].map(r => r.dataset.filepath), reads: window.__reads, open: document.querySelectorAll('#changed-files-list .file-diff:not([hidden])').length })`);
            check(`${tag}: back in the launch folder the list is its own and the worktree is offered`, JSON.stringify(back.files) === JSON.stringify(['launch.txt']) && /The agent is working in the worktree/.test(back.note) && /Follow it/.test(back.note), JSON.stringify(back));
            check(`${tag}: the launch folder was read with worktree=launch, and no diff of the other folder stays open`, back.reads.length > 0 && back.reads.every(r => r.mode === 'launch') && back.open === 0, JSON.stringify(back.reads));

            // and forward again
            await ev(`window.__reads = []; document.querySelector('#changed-files-list [data-on-click="worktree-follow"]').click(); true`);
            await waitFor(`!!document.querySelector('#changed-files-list [data-on-click="worktree-launch"]')`, `${tag}: following again`, 8000);
            check(`${tag}: following again reads worktree=follow`, (await ev(`window.__reads`)).every(r => r.mode === 'follow'), JSON.stringify(await ev(`window.__reads`)));
            check(`${tag}: the page does not scroll sideways`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'following the agent into its worktree:\n  ' + problems.join('\n  '));
    console.log('PASS the Files panel follows the agent into its worktree and goes back');
})().catch(e => { console.error(e); process.exit(1); });
