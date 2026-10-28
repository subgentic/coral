// What a person sees after Share as artifact (#10539, Desktop sharing pass 17:28): a file shared from the Files viewer is in that agent's own Artifacts tab at once (the tab was drawn before, with nothing in it);
// the Share button in the viewer's toolbar and on a Files row is whole (not cut at the top right of its bar); and the artifact sheet says in one line what Star and Keep each do. 1280 and 390 px; the routes are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const HEX = '5'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { const R = window.fetch; window.__artifacts = []; window.__posts = [];
                const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = (o.method || 'GET').toUpperCase(), p = url.pathname;
                    if (p === '/api/session-artifacts') return json({ session_id: url.searchParams.get('session_id'), artifacts: window.__artifacts, has_more: false, truncated: false });
                    if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
                    if (m === 'POST' && /\\/share-file$/.test(p)) { window.__posts.push(url.searchParams.get('filepath')); window.__artifacts = [{ name: 'report.md', uri: 'coral://artifacts/${HEX}', media_type: 'text/markdown', size: 9, created_at: new Date().toISOString(), produced_by: 'sh-bot' }]; return json({ uri: 'coral://artifacts/${HEX}', url: '/api/artifacts/${HEX}?v=2', name: 'report.md' }); }
                    if (/\\/api\\/sessions\\/live\\/[^/]+\\/files$/.test(p)) return json({ files: [{ filepath: 'out/report.md', status: '??', additions: 0, deletions: 0, recorded_at: '2026-10-28T09:00:00Z' }], diff_mode: 'branch_point', is_git: false });
                    if (/\\/file-content$/.test(p)) return json({ filepath: 'out/report.md', content: '# Report', working_directory: '/w' });
                    return R(u, o); };
                return true; })()`);
            await ev(`window.__m.add('sh-bot', 'A', 4, { sleeping: false }); true`); await sleep(800); // sleep-ok: the list redraws over frames
            await ev(`window.selectLiveSession('sh-bot', 'claude', 'sh-bot-id', 'local'); true`); await sleep(1200); // sleep-ok: the agent's page settles over frames
            if (mobile) await ev(`document.getElementById('popout-panel-toggle-btn')?.click(); true`).catch(() => {});

            // the Artifacts tab is drawn first, with nothing in it
            await ev(`window.switchAgenticTab('artifacts', 'top'); true`);
            await waitFor(`!!document.querySelector('#agentic-panel-artifacts-view .team-artifacts-body') && document.querySelectorAll('#agentic-panel-artifacts-view tbody tr').length === 0`, `${w}: the agent's Artifacts tab, empty`, 10000);

            // a file is shared from the Files tab
            await ev(`window.switchAgenticTab('files', 'top'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'changed_files.js').then(m => m.loadChangedFiles('sh-bot', 'sh-bot-id')).then(() => true)`);
            await waitFor(`!!document.querySelector('#changed-files-list [data-on-click="file-share"]')`, `${w}: the row's Share button`, 8000);
            const row = await ev(`(() => { const b = document.querySelector('#changed-files-list [data-on-click="file-share"]'), r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
            if (mobile) await ev(`(document.querySelector('#changed-files-list .file-more-btn') || { click() {} }).click(); true`);
            await ev(`document.querySelector('#changed-files-list [data-on-click="file-share"]').click(); true`);
            await waitFor(`window.__posts.length === 1`, `${w}: the share is sent`, 5000);
            await ev(`window.switchAgenticTab('artifacts', 'top'); true`);
            await waitFor(`document.querySelectorAll('#agentic-panel-artifacts-view tbody tr').length === 1`, `${w}: the shared file is in the Artifacts tab at once, with no Refresh`, 8000);
            assert.match(await ev(`document.querySelector('#agentic-panel-artifacts-view tbody tr').textContent`), /report\.md/, `${w}: it is the file that was shared`);

            // the sheet says what Star and Keep do
            await ev(`document.querySelector('#agentic-panel-artifacts-view tbody tr .artifact-details').click(); true`);
            await waitFor(`!document.getElementById('agentic-detail-pane').hidden`, `${w}: the sheet`, 6000);
            const note = await ev(`(document.querySelector('#agentic-detail-pane .detail-note') || {}).textContent || ''`);
            assert.match(note, /Star puts it in your Starred list\. Keep stops Coral.s cleanup from deleting the file\./, `${w}: one line says how Star and Keep differ: ${note}`);
            await ev(`document.getElementById('agentic-detail-pane').querySelector('.detail-close, [aria-label="Close"]')?.click(); true`);

            // the viewer's own Share button is whole
            await ev(`window.switchAgenticTab('files', 'top'); window.openFilePreview('out/report.md'); true`);
            await waitFor(`!!document.querySelector('#preview-toolbar [data-action="share-file"]')`, `${w}: the viewer's Share button`, 8000);
            const g = await ev(`(() => { const b = document.querySelector('#preview-toolbar [data-action="share-file"]'), t = document.getElementById('preview-toolbar'), r = b.getBoundingClientRect(), tr = t.getBoundingClientRect();
                let clipped = ''; for (let p = b.parentElement; p && p !== document.body; p = p.parentElement) { if (getComputedStyle(p).overflow !== 'visible') { const q = p.getBoundingClientRect(); if (r.top < q.top - 0.5 || r.bottom > q.bottom + 0.5 || r.right > q.right + 0.5 || r.left < q.left - 0.5) clipped = (p.id || p.className) + ':' + [q.top, q.right, q.bottom, q.left].map(Math.round); } if (getComputedStyle(p).position === 'fixed') break; }
                const all = [...t.querySelectorAll('button, .inline-preview-actions')].map(e => e.className.split(' ').slice(-2).join('.') + ':' + [e.getBoundingClientRect().top, e.getBoundingClientRect().bottom].map(Math.round));
                return { all, r: [r.top, r.right, r.bottom, r.left].map(Math.round), bar: [tr.top, tr.right, tr.bottom, tr.left].map(Math.round), clipped, w: Math.round(r.width), h: Math.round(r.height) }; })()`);
            assert.ok(!g.clipped && g.r[0] >= g.bar[0] - 1 && g.r[2] <= g.bar[2] + 1 && g.r[1] <= g.bar[1] + 1, `${w}: the viewer's Share button is inside its bar and not cut: ${JSON.stringify(g)}`);
            assert.ok(g.w >= 24 && g.h >= 24, `${w}: and is a real target: ${JSON.stringify(g)}`);
        }
        console.log('PASS Share as artifact: in the agent\'s Artifacts tab at once, the viewer\'s button whole, Star and Keep told apart, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
