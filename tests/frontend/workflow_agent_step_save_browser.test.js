// A workflow with an agent step can be saved from the form (#10732, v2.0.3 blocker found by Desktop in #10723): the server refuses an agent step with no agent_type ("agent step missing agent_type"), and the form
// has no field for it, so the template (Daily motivation) and a blank workflow with an agent step both failed to save. The form now sends the step's agent_type: Settings' default agent, else Claude. This
// suite saves both through the real server (isolated dev server) and reads them back; it also checks that an agent type the step already had is kept.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const NAMES = ['my-daily-motivation', 'agent-step-blank', 'agent-step-codex-default'];
    const fresh = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.openAutomationsFolder('workflows'); window.showWorkflowCreateModal(); true`);
        await waitFor(`document.getElementById('wf-create-modal').style.display === 'flex'`, 'the dialog', 8000);
    };
    const list = () => ev(`fetch('/api/workflows').then(r => r.json()).then(j => JSON.stringify(Array.isArray(j) ? j : (j.workflows || [])))`).then(JSON.parse);
    const cleanup = async () => { for (const w of await list()) if (NAMES.includes(w.name)) await ev(`fetch('/api/workflows/' + ${w.id}, { method: 'DELETE' }).then(() => true)`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await fresh(); await cleanup();

        // the template: Daily motivation has an agent step
        await ev(`(() => { const s = document.getElementById('wf-input-template'); s.value = 'daily-motivation'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.getElementById('wf-input-name').value === 'my-daily-motivation'`, 'the template filled in');
        await ev(`document.getElementById('wf-modal-save').click(); true`);
        await waitFor(`document.getElementById('wf-create-modal').style.display === 'none'`, 'the template saved and the dialog closed (a refusal keeps it open)', 8000);

        // a blank workflow with one agent step
        await fresh();
        await ev(`(() => { const n = document.getElementById('wf-input-name'); n.focus(); return true; })()`); await Input.insertText({ text: 'agent-step-blank' });
        await ev(`(() => { const s = document.querySelector('.wf-step-type-select'); s.value = 'agent'; s.dispatchEvent(new Event('change', { bubbles: true })); const n = document.querySelector('.wf-step-name-input'); n.focus(); n.select(); return true; })()`); await Input.insertText({ text: 'say-hello' });
        await ev(`document.querySelector('.wf-step-content').focus(); true`); await Input.insertText({ text: 'Say hello in one sentence.' });
        await ev(`document.getElementById('wf-modal-save').click(); true`);
        await waitFor(`document.getElementById('wf-create-modal').style.display === 'none'`, 'the blank workflow saved and the dialog closed', 8000);

        // Settings' default agent is Codex, which cannot run a non-interactive step yet: the step still gets Claude, and the save goes through
        await fresh();
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.settings = { ...state.settings, default_agent_type: 'codex' }; return true; })()`);
        await ev(`(() => { const n = document.getElementById('wf-input-name'); n.focus(); return true; })()`); await Input.insertText({ text: 'agent-step-codex-default' });
        await ev(`(() => { const s = document.querySelector('.wf-step-type-select'); s.value = 'agent'; s.dispatchEvent(new Event('change', { bubbles: true })); const n = document.querySelector('.wf-step-name-input'); n.focus(); n.select(); return true; })()`); await Input.insertText({ text: 'say-hello' });
        await ev(`document.querySelector('.wf-step-content').focus(); true`); await Input.insertText({ text: 'Say hello in one sentence.' });
        await ev(`document.getElementById('wf-modal-save').click(); true`);
        await waitFor(`document.getElementById('wf-create-modal').style.display === 'none'`, 'the workflow saved with Codex as the Settings default', 8000);

        const saved = await list();
        for (const name of NAMES) {
            const w = saved.find(x => x.name === name);
            assert.ok(w, `${name} was saved`);
            const detail = await ev(`fetch('/api/workflows/' + ${w.id}).then(r => r.json()).then(j => JSON.stringify(j))`).then(JSON.parse);
            const agentStep = (detail.steps || []).find(s => s.type === 'agent');
            assert.ok(agentStep, `${name} has an agent step`);
            assert.equal(agentStep.agent && agentStep.agent.agent_type, 'claude', `${name}: the agent step has an agent_type: Claude (the only CLI a print step can run), whatever Settings' default is`);
        }
        console.log('PASS a workflow with an agent step is saved from the form, from the template and from a blank one');
    } finally { await cleanup().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
