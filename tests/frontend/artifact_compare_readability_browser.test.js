// #16974: compare keeps code lines intact and comments available at desktop width.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(STUB);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'artifact_viewer.js'); m.openArtifactViewer('${H3}', { filename: 'release-plan.md' }); return true; })()`);
        await waitFor(`document.querySelector('#artifact-viewer .av-current') && document.querySelector('#artifact-viewer .ac-toggle')`, 'Version and comments controls');
        await ev(`document.querySelector('#artifact-viewer .ac-toggle').click(); document.querySelector('#artifact-viewer .av-current').click(); true`);
        await waitFor(`document.querySelector('#artifact-viewer .ac-panel').classList.contains('ac-sheet-open')`, 'Comments open before compare');
        await ev(`document.querySelector('#artifact-viewer .av-compare').click(); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .av-lines')`, 'Changes loaded');
        const check = async mode => {
            const result = await ev(`(() => {
                const root = document.getElementById('artifact-viewer');
                const line = root.querySelector('.av-line'), css = getComputedStyle(line);
                const panel = root.querySelector('.ac-panel'), toggle = root.querySelector('.ac-toggle');
                const vis = e => e && getComputedStyle(e).display !== 'none' && !!e.getClientRects().length;
                return { font: css.fontFamily, wrap: css.whiteSpace, panel: vis(panel), toggle: vis(toggle),
                    highlights: [...root.querySelectorAll('.av-add, .av-del')].map(e => getComputedStyle(e).backgroundColor) };
            })()`);
            if (!/mono/i.test(result.font)) failures.push(mode + ': code font is ' + result.font);
            if (result.wrap !== 'pre') failures.push(mode + ': code wraps (' + result.wrap + ')');
            if (!result.toggle || !result.panel) failures.push(mode + ': comments disappear');
            if (!result.highlights.length || result.highlights.some(c => c === 'rgba(0, 0, 0, 0)' || c === 'transparent')) failures.push(mode + ': changed lines lack highlighting');
            await shot('1280-' + mode);
            const scrolls = await ev(`(() => {
                const line = document.querySelector('#artifact-viewer .av-line');
                const old = line.textContent; line.textContent = 'long_code_path/'.repeat(100);
                const scroller = line.closest('.av-col, .av-lines');
                const ok = scroller.scrollWidth > scroller.clientWidth && getComputedStyle(scroller).overflowX === 'auto';
                line.textContent = old; return ok;
            })()`);
            if (!scrolls) failures.push(mode + ': long lines do not scroll horizontally');
        };
        await check('changes');
        await ev(`document.querySelector('#artifact-viewer .av-view-split').click(); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .av-split')`, 'Split loaded');
        await check('split');
        assert.deepEqual(failures, []);
        console.log('PASS compare code font, no wrapping, highlights and comments at 1280');
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exit(1); });
