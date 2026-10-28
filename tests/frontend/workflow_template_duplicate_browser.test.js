// Start a workflow from an example (#10277, Mobile #10267): New workflow has "Start from a template" with Daily motivation (the workflow Coral seeds) first, which fills the name and both steps without saving anything;
// a workflow's More menu has Duplicate, which opens New workflow filled from it with its name and "-copy". Both create through POST /api/workflows (stubbed, its body read). 1280 and 390 px, the isolated dev server's
// seeded daily-motivation.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const STUB = `(() => { const real = window.fetch; window.__saved = [];
    window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/workflows' && m === 'POST') { window.__saved.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ id: 99, name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })); }
        if (p === '/api/workflows/77' && m === 'GET') return Promise.resolve(new Response(JSON.stringify({ id: 77, name: 'daily-motivation', description: 'Example: generates a motivational message', enabled: 1, max_duration_s: 1800, repo_path: '',
            steps: [{ name: 'generate-message', type: 'agent', prompt: 'Say something kind.' }, { name: 'show-notification', type: 'shell', command: 'echo hi' }], runs: [], run_count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }));
        if (p.startsWith('/api/workflows/77/runs')) return Promise.resolve(new Response(JSON.stringify({ runs: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }));
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stepCount = () => ev(`document.querySelectorAll('#wf-steps-editor .wf-step-content').length`);
    const create = async () => { await ev(`document.getElementById('wf-modal-save').click(); true`); await waitFor(`window.__saved.length >= 1`, 'the create request', 6000); return ev(`window.__saved.pop()`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`); await ev(STUB);

            // 1. a template fills the form, and saves nothing until Create
            await ev(`window.openAutomationsFolder('workflows'); window.showWorkflowCreateModal(); true`);
            await waitFor(`document.getElementById('wf-create-modal').style.display === 'flex'`, 'the dialog', 8000);
            const opts = await ev(`[...document.querySelectorAll('#wf-input-template option')].map(o => o.textContent.trim())`);
            assert.deepEqual(opts, ['A blank workflow', 'Daily motivation (example)'], at + 'the template choices: ' + JSON.stringify(opts));
            assert.equal(await stepCount(), 1, at + 'a blank workflow starts with the one example step');
            await ev(`(() => { const s = document.getElementById('wf-input-template'); s.value = 'daily-motivation'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#wf-steps-editor .wf-step-content').length === 2`, 'the template steps', 6000);
            assert.equal(await ev(`document.getElementById('wf-input-name').value`), 'my-daily-motivation', at + 'the name');
            assert.equal(await ev(`window.__saved.length`), 0, at + 'nothing is saved by choosing it');
            const made = await create();
            assert.equal(made.name, 'my-daily-motivation'); assert.deepEqual(made.steps.map(s => [s.name, s.type]), [['generate-message', 'agent'], ['show-notification', 'shell']], at + JSON.stringify(made.steps));
            await waitFor(`document.getElementById('wf-create-modal').style.display === 'none'`, 'the dialog closing after Create', 6000);

            // 2. Duplicate in a workflow's More menu
            const id = 77; // a workflow the page reads from the stub
            await ev(`window.selectWorkflow(${id}); true`);
            await waitFor(`!!document.querySelector('.wf-more-btn')`, 'the workflow page', 8000);
            await ev(`document.querySelector('.wf-more-btn').click(); true`);
            const items = await ev(`[...document.querySelectorAll('.wf-more-menu:not([hidden]) .menu-item')].map(b => b.textContent.trim())`);
            assert.deepEqual(items, ['Duplicate', 'Delete'], at + 'the More menu: ' + JSON.stringify(items));
            await ev(`document.querySelector('.wf-more-menu:not([hidden]) [data-on-click="wf-duplicate"]').click(); true`);
            await waitFor(`document.getElementById('wf-create-modal').style.display === 'flex' && document.getElementById('wf-input-name').value === 'daily-motivation-copy'`, 'the duplicate dialog', 8000);
            assert.equal(await ev(`document.getElementById('wf-modal-title').textContent`), 'New workflow');
            assert.equal(await stepCount(), 2, at + 'both steps are copied');
            assert.equal(await ev(`(() => { const r = document.getElementById('wf-input-template')?.closest('.sv-row'); return !r || r.hidden; })()`), true, at + 'no template row on a copy');
            const dup = await create();
            assert.equal(dup.name, 'daily-motivation-copy'); assert.deepEqual(dup.steps.map(s => s.name), ['generate-message', 'show-notification'], at + JSON.stringify(dup.steps));
            console.log(`PASS ${at}a template and Duplicate both start a workflow from an example`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
