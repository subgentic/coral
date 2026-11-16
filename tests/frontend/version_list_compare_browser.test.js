// #17522: Compare from the versions list itself; source diff and sandboxed rendered HTML, at 390 dark/touch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' });
        await Page.loadEventFired();
        await install(); await coralReady(ev); await setTheme(ev, 'dark');
        await ev(`(() => {
            const real = window.fetch; window.__pwned = 0;
            window.fetch = (u, opts) => {
                const p = new URL(String(u), location.origin).pathname;
                if (p.startsWith('/api/artifacts/') && p.endsWith('/versions')) return Promise.resolve(new Response(JSON.stringify([...Array.from({ length: 5 }, (_, i) => ({ version: i + 1, digest: 'a'.repeat(64), at: '2026-11-14T21:' + (10 + i) + ':00Z', uploader: 'Orchestrator' })), { version: 6, digest: 'b'.repeat(64), at: '2026-11-14T21:40:00Z', role: 'operator' }]), { status: 200, headers: { 'content-type': 'application/json' } })); // a real series (#18644: without one the list is only uploads of the same name, with no Compare)
                if (p.startsWith('/api/artifacts/')) return Promise.resolve(new Response('<h1>' + (p.includes('bbbb') ? 'New tip' : 'Old tip') + '</h1>\\n<script>parent.__pwned = 1</script>', { headers: { 'content-type': 'text/html' } }));
                return real(u, opts);
            }; return true;
        })()`);
        await ev(`import((window.__coralStatic || '/static/') + 'artifact_version_list.js').then(m => m.openVersionList({ hex: '${'b'.repeat(64)}', server: '', board: 'version-list-17522', name: 'tip-calculator-with-a-long-file-name-for-the-phone.html', current: { hex: '${'b'.repeat(64)}', at: '2026-11-14T21:40:00Z', role: 'operator' }, earlier: Array.from({ length: 5 }, (_, i) => ({ hex: '${'a'.repeat(64)}', at: '2026-11-14T21:' + (10+i) + ':00Z', produced_by: 'Orchestrator' })), open() {} })).then(() => true)`);
        await ev(framesJs(3)); await shot('versions-390');
        const title = await ev(`(() => { const d = document.querySelector('.version-list-dialog'), t = d.querySelector('h2').getBoundingClientRect(), r = d.getBoundingClientRect(); return { top: t.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight }; })()`);
        if (!(title.top >= 0 && title.bottom <= title.vh && title.left >= 0 && title.right <= title.vw)) problems.push(`dialog/title stays in viewport: ${JSON.stringify(title)}`);
        const compare = await ev(`!!document.querySelector('.version-list-entry:last-child .version-list-compare')`);
        if (!compare) problems.push('Compare is available for the newest version');
        if (compare) {
            await ev(`document.querySelector('.version-list-entry:last-child .version-list-compare').click(); true`);
            await waitFor(`!!document.querySelector('.version-compare-source')`, 'source changes');
            assert.ok(await ev(`document.querySelector('.version-compare-source ins').textContent.includes('New tip') && document.querySelector('.version-compare-source del').textContent.includes('Old tip')`), 'the HTML source is diffed as text');
            await shot('source-390');
            await ev(`[...document.querySelectorAll('.version-compare-tools button')].find(b => b.textContent === 'Rendered side by side').click(); true`);
            await waitFor(`document.querySelectorAll('.version-compare-preview iframe').length === 2`, 'two rendered versions');
            assert.ok(await ev(`[...document.querySelectorAll('.version-compare-preview iframe')].every(f => f.getAttribute('sandbox') === '' && f.srcdoc.includes('Content-Security-Policy')) && window.__pwned === 0`), 'HTML previews use empty sandboxes and CSP; scripts never run');
            await ev(framesJs(3)); await shot('rendered-390');
            await ev(`[...document.querySelectorAll('.version-compare-tools button')].find(b => b.textContent === 'Back to versions').click(); true`);
            assert.equal(await ev(`document.querySelectorAll('.version-list-entry').length`), 6, 'back restores the list');
        }
        assert.deepEqual(problems, []);
        console.log('version_list_compare: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
