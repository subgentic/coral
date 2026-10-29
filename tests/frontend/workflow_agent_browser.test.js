// "Build with Agent" and "Edit with Agent" on the Workflows pages (#8360 pins them before workflows.js is split): the builder's skill prompt is read, the agent is launched on this computer's coral root
// with that prompt, and a toast names it; an edit launches in the workflow's own folder with the workflow's definition and the PUT instruction in the prompt. Refusals say why: no skill, no working
// directory, a launch error. The server's answers are stubbed in the page; the launches are recorded.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => { window.__launches = []; window.__skill = { content: 'You are the Workflow Builder.' }; window.__launchAnswer = { session_name: 'claude-wb-1', session_id: 'wb-1' };
            document.body.dataset.coralRoot = '/repo/coral'; const R = window.fetch;
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/agent-docs/workflow-builder') return json(window.__skill);
                if (url.pathname === '/api/workflows/7') return json({ id: 7, name: 'Nightly build', repo_path: '/repo/nightly', steps: [{ name: 'Test', type: 'shell', command: 'make test' }] });
                if (url.pathname === '/api/sessions/launch') { window.__launches.push(JSON.parse(o.body)); return json(window.__launchAnswer); }
                return R(u, o); };
            return true; })()`);
        const toasts = () => ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`);
        const clearToasts = () => ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__launches.length = 0; true`);
        const call = (fn, ...args) => ev(`import(${S} + 'workflows.js').then(m => m.${fn}(${args.map(a => JSON.stringify(a)).join(', ')})).then(() => true)`);

        console.log('1. Build with Agent launches the builder with its skill, in the coral root');
        await call('launchWorkflowAgent');
        assert.equal(await ev(`window.__launches.length`), 1, 'one launch');
        const l1 = await ev(`window.__launches[0]`);
        assert.equal(l1.working_dir, '/repo/coral'); assert.equal(l1.agent_type, 'claude'); assert.equal(l1.display_name, 'Workflow Builder'); assert.equal(l1.prompt, 'You are the Workflow Builder.');
        assert.deepEqual(l1.capabilities.allow, ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']);
        assert.ok((await toasts()).some(t => /Launched: Workflow Builder/.test(t)), 'the toast names the agent ' + JSON.stringify(await toasts()));
        console.log('   ✓');

        console.log('2. Edit with Agent launches in the workflow\'s folder with its definition and the PUT instruction');
        await clearToasts();
        await call('editWorkflowWithAgent', 7);
        assert.equal(await ev(`window.__launches.length`), 1, 'one launch');
        const l2 = await ev(`window.__launches[0]`);
        assert.equal(l2.working_dir, '/repo/nightly', 'the workflow\'s own folder'); assert.equal(l2.display_name, 'Edit: Nightly build');
        assert.ok(l2.prompt.startsWith('You are the Workflow Builder.'), 'the skill first');
        assert.ok(l2.prompt.includes('"name": "Nightly build"') && l2.prompt.includes('make test'), 'the workflow\'s definition is in the prompt');
        assert.ok(l2.prompt.includes('/api/workflows/7') && /PUT/.test(l2.prompt), 'the update goes to this workflow by PUT');
        assert.ok((await toasts()).some(t => /Launched: Edit Nightly build/.test(t)), 'the toast names it ' + JSON.stringify(await toasts()));
        console.log('   ✓');

        console.log('3. Refusals say why and launch nothing');
        await clearToasts();
        await ev(`window.__skill = {}; true`); await call('launchWorkflowAgent');
        assert.equal(await ev(`window.__launches.length`), 0, 'no skill: no launch');
        assert.ok((await toasts()).some(t => /Workflow builder skill not found/.test(t)), 'no skill says so ' + JSON.stringify(await toasts()));
        await clearToasts();
        await ev(`window.__skill = { content: 'x' }; document.body.dataset.coralRoot = ''; true`); await call('launchWorkflowAgent');
        assert.equal(await ev(`window.__launches.length`), 0, 'no folder: no launch');
        assert.ok((await toasts()).some(t => /Could not determine working directory/.test(t)), 'no folder says so ' + JSON.stringify(await toasts()));
        await clearToasts();
        await ev(`document.body.dataset.coralRoot = '/repo/coral'; window.__launchAnswer = { error: 'No room for another agent' }; true`); await call('launchWorkflowAgent');
        assert.ok((await toasts()).some(t => /No room for another agent/.test(t)), 'a launch error is shown ' + JSON.stringify(await toasts()));
        console.log('   ✓');
        console.log('PASS Workflows: Build with Agent and Edit with Agent launch the builder, with their prompts and refusals');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
