// New job's folder, defaults and edge (#10276, Mobile pass 19): the field says Folder and what it needs (a git folder with a commit), has a Browse button that opens the folder list, When opens on Daily
// at 09:00, and a form taller than the window has a soft edge at its foot (a scroll shade) so the Prompt below the fold is known to be there. 1280x820 and 390x600. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const fs = require('node:fs');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 600, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('job-modal-name') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, `${w}: the New job dialog`, 8000);
            await ev(`(() => { const b = [...document.querySelectorAll('#job-type-toggle button')].find(x => x.dataset.type === 'prompt'); if (b) b.click(); return true; })()`);
            await waitFor(`!!document.getElementById('job-modal-repo') && document.getElementById('job-modal-repo').getClientRects().length > 0`, `${w}: the folder field`, 5000);
            const g = await ev(`(() => {
                const input = document.getElementById('job-modal-repo'), row = input.closest('.sv-row, .sv-field') || input.parentElement.parentElement;
                const label = [...document.querySelectorAll('#job-form label, #job-form .sv-label')].find(l => l.htmlFor === 'job-modal-repo' || l.getAttribute('for') === 'job-modal-repo');
                const browse = document.getElementById('btn-browse-job');
                return { label: label && label.textContent.trim(), text: row.textContent.replace(/\\s+/g, ' '), browseInRow: !!browse && row.contains(browse) && browse.getClientRects().length > 0, browseSameLine: !!browse && Math.abs(browse.getBoundingClientRect().top - input.getBoundingClientRect().top) < 24,
                    cron: document.getElementById('job-modal-cron').value, mode: [...document.querySelectorAll('#sched-picker .sched-preset')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.mode), at: document.getElementById('job-modal-at').value,
                    shade: getComputedStyle(document.getElementById('job-form').closest('.modal-body') || document.getElementById('job-form')).backgroundImage.split('linear-gradient').length - 1 };
            })()`);
            assert.equal(g.label, 'Folder', `${w}: the field is called Folder: ${JSON.stringify(g)}`);
            assert.match(g.text, /a git folder with at least one commit/, `${w}: it says what it needs`);
            assert.ok(g.browseInRow && g.browseSameLine, `${w}: Browse sits beside the input ${JSON.stringify(g)}`);
            assert.equal(g.cron, '0 9 * * *', `${w}: a new job runs daily at 09:00`);
            assert.deepEqual(g.mode, ['daily'], `${w}: the Daily picker is the one pressed`);
            assert.equal(g.at, '09:00');
            assert.equal(g.shade, 4, `${w}: the form's body has its scroll shades`);
            await shot(`job-folder-${w}`);
            await ev(`document.getElementById('btn-browse-job').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('dir-browser-job')).display !== 'none'`, `${w}: Browse opens the folder list`, 5000);
        }
        console.log('PASS New job: Folder with Browse and its need, Daily 09:00 by default, scroll shades on the body, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
