// A first visit to Automations (#9297, the Operator's audit 2 and 9): with no job and no workflow every folder offers two cards, "Run a prompt on a schedule" and "Run steps from a workflow";
// the first opens New job on the Agent prompt; the New workflow form starts with an example step and a Build with Agent hint. The isolated server has no jobs and no workflows. 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility(); })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            for (const folder of ['jobs', 'workflows', 'running', 'failed', 'recent']) {
                await ev(`window.openAutomationsFolder(${JSON.stringify(folder)}); true`);
                await waitFor(`document.querySelectorAll('#group-table-view .start-card').length === 2`, `${at}${folder}: the two cards`, 8000);
                assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .start-card .start-card-title')].map(e => e.textContent)`), ['Run a prompt on a schedule', 'Run steps from a workflow'], at + folder);
            }
            await ev(`window.openAutomationsFolder('jobs'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view .start-card').length === 2`, 'the cards', 8000);
            await shot(`first-run-cards-${w}`);
            if (mobile) assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, at + 'no sideways scroll');

            // the first card: New job, on the Agent prompt
            await ev(`document.querySelectorAll('#group-table-view .start-card')[0].click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('job-modal')).display !== 'none' && document.querySelector('.job-type-btn[data-type="prompt"]').getAttribute('aria-pressed') === 'true'`, 'New job opens on the Agent prompt', 8000);
            assert.equal(await ev(vis('#job-modal-prompt')), true, at + 'the Prompt is the first thing to fill in');
            await waitFor(`(() => { const [a, b] = ['workflow', 'prompt'].map(t => getComputedStyle(document.querySelector('.job-type-btn[data-type="' + t + '"]')).backgroundColor); return a !== b; })()`, 'the type buttons have settled', 8000); // the dialog fades in: the shot is the settled one
            await shot(`first-run-job-${w}`);
            await ev(`document.querySelector('.job-type-btn[data-type="workflow"]').click(); true`);
            await waitFor(`document.getElementById('job-modal-no-workflows').checkVisibility()`, 'the no-workflow line', 8000);
            await shot(`first-run-job-workflow-${w}`);
            await ev(`[...document.querySelectorAll('#job-footer button')].find(b => b.textContent.trim() === 'Cancel').click(); true`);

            // the second card: New workflow, with an example step and the hint
            await ev(`document.querySelectorAll('#group-table-view .start-card')[1].click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('wf-create-modal')).display !== 'none'`, 'New workflow opens', 8000);
            assert.equal(await ev(`document.querySelector('.wf-step-name-input').value + ' / ' + document.querySelector('.wf-step-content').value`), 'Run tests / ', at + 'the example step is named, its command empty');
            assert.equal(await ev(`document.querySelector('.wf-step-content').placeholder`), 'e.g. npm test', at + 'with the example as its placeholder');
            assert.equal(await ev(vis('#wf-build-hint')), true, at + 'the Build with Agent hint');
            await shot(`first-run-workflow-${w}`);
            await ev(`[...document.querySelectorAll('#wf-footer button')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
            assert.equal(await ev(`getComputedStyle(document.getElementById('job-modal')).display`), 'none', at + 'a workflow dialog opened from a card does not bring New job back');
        }
        console.log('PASS first run: two cards in every folder, New job on the Agent prompt, New workflow with an example step and the hint');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
