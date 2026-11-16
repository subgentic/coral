// Download a file the team built (#17632, walk 78): a Files row and the open preview each have a Download button that saves the file under its own name with its own content; a file
// that cannot be read says why and saves nothing. 1280 px and 390 px (the row's buttons sit behind More there). The routes are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SID = '0b2f6c1e-3d4a-4b5c-8d6e-000000010269';
const NAME = 'claude-' + SID;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const stub = () => ev(`(() => { const R = window.fetch; window.__saved = []; window.__asked = []; window.__refuse = false; window.__blobs = {}; const mk = URL.createObjectURL; URL.createObjectURL = b => { const u = mk.call(URL, b); window.__blobs[u] = b; return u; };
        const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (/\\/api\\/sessions\\/live\\/[^/]+\\/files(\\?|$)/.test(url)) return json({ files: [{ filepath: 'out/report.html', status: '??', additions: 0, deletions: 0, recorded_at: '2026-10-28T09:00:00Z' }, { filepath: 'out/bundle.zip', status: '??', additions: 0, deletions: 0, recorded_at: '2026-10-28T08:00:00Z' }], diff_mode: 'branch_point', is_git: false });
            if (/\\/file-content\\?/.test(url) && /download=1/.test(url)) { window.__asked.push(url); return window.__refuse ? json({ error: 'File not found' }, 404) : Promise.resolve(new Response(/bundle\\.zip/.test(url) ? new Uint8Array([80, 75, 3, 4, 0, 255, 254, 128]) : '<h1>Report</h1>', { status: 200 })); }
            if (/\\/file-content\\?/.test(url)) return window.__refuse ? json({ error: 'File not found' }, 404) : json({ filepath: 'out/report.html', content: '<h1>Report</h1>', working_directory: '/w' });
            return R(u, o); };
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) { const rec = { name: this.download, text: null }; window.__saved.push(rec); (window.__blobs[this.href] || new Blob([])).arrayBuffer().then(b => { const u = [...new Uint8Array(b)]; rec.bytes = u; rec.text = new TextDecoder().decode(new Uint8Array(u)); }); return; } return click.call(this); };
        return true; })()`);
    const toast = () => ev(`(() => { const t = document.querySelector('.toast'); return t ? t.querySelector('.toast-message').textContent : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await stub();
            await ev(`(async () => { const st = (await import(${MOD} + 'state.js')).state; st.currentSession = { type: 'live', name: ${JSON.stringify(NAME)}, session_id: ${JSON.stringify(SID)} };
                const m = await import(${MOD} + 'changed_files.js'); await m.loadChangedFiles(${JSON.stringify(NAME)}, ${JSON.stringify(SID)}); return true; })()`);
            const label = await ev(`(() => { const b = document.querySelector('#changed-files-list .file-item [data-on-click="file-download"]'); return b ? b.getAttribute('aria-label') : null; })()`);
            assert.equal(label, 'Download report.html', `${w}: the row has a Download button that names its file`);
            await ev(`document.querySelector('#changed-files-list [data-on-click="file-download"]').click(); true`);
            await waitFor(`window.__saved.length === 1 && window.__saved[0].text !== null`, 5000);
            let saved = await ev(`window.__saved[0]`);
            assert.equal(saved.name, 'report.html', `${w}: saved under the file's name`);
            assert.equal(saved.text, '<h1>Report</h1>', `${w}: with the file's content`);

            // every file type has Download, on its row and in its preview, and saves the exact bytes the server's download mode sends (#17655): a zip is not read as text
            assert.equal(await ev(`document.querySelectorAll('#changed-files-list .file-item').length`), 2, `${w}: the zip is listed too`);
            assert.ok((await ev(`window.__asked[0]`)).includes('download=1'), `${w}: the row asks the server's download mode`);
            const before = await ev(`window.__saved.length`);
            await ev(`[...document.querySelectorAll('#changed-files-list .file-item')].find(x => (x.dataset.filepath || '').endsWith('bundle.zip')).querySelector('[data-on-click="file-download"]').click(); true`);
            await waitFor(`window.__saved.length === ${before + 1} && window.__saved[${before}].bytes`, 5000);
            const zip = await ev(`window.__saved[${before}]`);
            assert.equal(zip.name, 'bundle.zip', `${w}: the zip is saved under its name`);
            assert.deepEqual(zip.bytes, [80, 75, 3, 4, 0, 255, 254, 128], `${w}: with its exact bytes`);
            await ev(`window.__saved.splice(${before}, 1); true`);

            // the open preview has the same button
            await ev(`window.openFilePreview('out/report.html'); true`);
            await waitFor(`!!document.querySelector('#preview-toolbar [data-action="download-file"]')`, 5000);
            await ev(`document.querySelector('#preview-toolbar [data-action="download-file"]').click(); true`);
            await waitFor(`window.__saved.length === 2 && window.__saved[1].text !== null`, 5000);
            assert.equal(await ev(`window.__saved[1].name`), 'report.html', `${w}: the preview saves it too`);

            // a file that cannot be read says why and saves nothing
            await ev(`window.__refuse = true; document.querySelector('#preview-toolbar [data-action="download-file"]').click(); true`);
            await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /report\\.html could not be read \\(404\\)\\. Nothing was saved/.test(e.textContent))`, 5000);
            assert.equal(await ev(`window.__saved.length`), 2, `${w}: nothing was saved`);
            await ev(`window.openFilePreview('out/bundle.zip'); true`);
            await waitFor(`(document.querySelector('#preview-toolbar .preview-toolbar-path') || {}).textContent === 'out/bundle.zip'`, 5000);
            assert.equal(await ev(`!!document.querySelector('#preview-toolbar [data-action="download-file"]')`), true, `${w}: a zip's preview has Download too`);
        }
        console.log('PASS Download a file: a Files row and the open preview save the file under its name with its content, a failure says why and saves nothing, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
