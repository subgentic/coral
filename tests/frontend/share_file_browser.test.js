// Share as artifact (#10269): a Files row and the open preview each have a button that makes an artifact from that file; the toast says so, shows the link and offers Copy link, and a
// refusal is said in words. 1280 px and 390 px (the row's buttons sit behind More there). The routes are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SID = '0b2f6c1e-3d4a-4b5c-8d6e-000000010269';
const NAME = 'claude-' + SID;
const URI = 'coral://artifacts/' + 'ab12cd34'.repeat(8);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const stub = () => ev(`(() => { const R = window.fetch; window.__posts = []; window.__refuse = false; window.__copied = [];
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (/\\/api\\/sessions\\/live\\/[^/]+\\/files(\\?|$)/.test(url)) return json({ files: [{ filepath: 'out/report.md', status: '??', additions: 0, deletions: 0, recorded_at: '2026-10-28T09:00:00Z' }], diff_mode: 'branch_point', is_git: false });
            if (/\\/share-file\\?/.test(url)) { window.__posts.push({ url, method: (o && o.method) || 'GET' }); return window.__refuse ? json({ error: 'File too large' }, 413) : json({ uri: ${JSON.stringify(URI)}, url: '/api/artifacts/x?v=2', name: 'report.md' }); }
            if (/\\/file-content\\?/.test(url)) return json({ filepath: 'out/report.md', content: '# Report', working_directory: '/w' });
            return R(u, o); };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } } });
        return true; })()`);
    const toast = () => ev(`(() => { const t = document.querySelector('.toast'); return t ? { text: t.querySelector('.toast-message').textContent, action: (t.querySelector('.toast-action') || {}).textContent || '' } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
            await ev(`(async () => { const st = (await import(${MOD} + 'state.js')).state; st.currentSession = { type: 'live', name: ${JSON.stringify(NAME)}, session_id: ${JSON.stringify(SID)} };
                const m = await import(${MOD} + 'changed_files.js'); await m.loadChangedFiles(${JSON.stringify(NAME)}, ${JSON.stringify(SID)}); return true; })()`);
            const label = await ev(`(() => { const b = document.querySelector('#changed-files-list .file-item [data-on-click="file-share"]'); return b ? b.getAttribute('aria-label') : null; })()`);
            assert.equal(label, 'Share report.md as an artifact', `${w}: the row has a Share button that names its file`);
            await ev(`document.querySelector('#changed-files-list [data-on-click="file-share"]').click(); true`);
            await waitFor(`window.__posts.length === 1`, 3000);
            const post = await ev(`window.__posts[0]`);
            assert.equal(post.method, 'POST', `${w}: a POST`);
            assert.match(post.url, new RegExp(`/api/sessions/live/${NAME}/share-file\\?.*filepath=out%2Freport\\.md`), `${w}: the file's path: ${post.url}`);
            assert.match(post.url, new RegExp(`session_id=${SID}`), `${w}: the agent's session`);
            await waitFor(`!!document.querySelector('.toast .toast-action')`, 3000);
            let t = await toast();
            assert.match(t.text, /^Shared report\.md as an artifact: coral:\/\/artifacts\/ab12cd34/, `${w}: the toast shows the link: ${t.text}`);
            assert.equal(t.action, 'Copy link', `${w}: and offers to copy it`);
            await ev(`document.querySelector('.toast .toast-action').click(); true`);
            await waitFor(`window.__copied.length === 1`, 3000);
            assert.equal(await ev(`window.__copied[0]`), URI, `${w}: Copy link copies the whole link`);

            // the open preview has the same button
            await ev(`(async () => { window.openFilePreview('out/report.md'); return true; })()`);
            await waitFor(`!!document.querySelector('#preview-toolbar [data-action="share-file"]')`, 5000);
            await ev(`window.__refuse = true; document.querySelector('#preview-toolbar [data-action="share-file"]').click(); true`);
            await waitFor(`window.__posts.length === 2`, 3000);
            await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /File too large/.test(e.textContent))`, 3000);
        }
        console.log('PASS Share as artifact: a Files row and the open preview share the file, the toast shows the link with Copy link, a refusal says why, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
