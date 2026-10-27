// Workflows and Jobs for a person using a screen reader or only the keyboard (#6348): the sidebar's Active / Scheduled buttons say which is on (aria-pressed); the workflow editor says what is wrong in
// an alert, marks the field and puts focus on it (Name, then a step's name or command); the job editor does the same for Name and Cron expression, and its "Valid / Invalid" cron line is a status
// the cron field is described by. Desktop and a 390 px phone. Drives Chrome over CDP through agent_view_harness.js with the census data world (helpers/census_world.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const state = () => ev(`(() => { const a = document.activeElement; return { id: a && a.id, cls: a && typeof a.className === 'string' ? a.className : '' }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        for (const [w, h, mobile, tag] of [[1280, 800, false, 'desktop'], [390, 844, true, 'phone']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

            // (the sidebar's Active / Scheduled buttons are gone: one list of every job, #6521)

            // the workflow editor
            await ev(`window.openAutomationsFolder('workflows'); true`);
            await waitFor(`!!document.querySelector('#group-table-view tbody tr[data-key] .dt-primary')`, `${tag}: workflows`, 10000);
            await ev(`document.querySelector('#group-table-view tbody tr[data-key] .dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('[data-on-click="wf-edit"]')`, `${tag}: workflow`, 10000);
            await ev(`document.querySelector('[data-on-click="wf-edit"]').click(); true`);
            await waitFor(`!!document.querySelector('#wf-create-modal .wf-add-step-btn') && !!document.querySelector('#wf-steps-editor .wf-step-editor-item')`, `${tag}: the editor`, 10000);
            const save = () => ev(`import(${S} + 'workflows.js').then(m => m.saveWorkflow()).then(() => true)`);
            const err = () => ev(`(() => { const e = document.querySelector('#wf-form .sv-error:not([hidden])'); return { role: e && e.getAttribute('role'), text: e ? e.textContent.trim() : '', shown: !!e }; })()`);
            await ev(`document.getElementById('wf-input-name').value = ''; true`); await save();
            let e = await err();
            assert.ok(e.shown && /Give the workflow a name/.test(e.text) && e.role === null, `${tag}: an empty name is said under the field (described, not an alert: the status line announces it) (${JSON.stringify(e)})`);
            let a = await state(); assert.equal(a.id, 'wf-input-name', `${tag}: focus is on the Name field (${JSON.stringify(a)})`);
            assert.equal(await ev(`document.getElementById('wf-input-name').getAttribute('aria-invalid')`), 'true', `${tag}: the Name field is marked`);
            assert.match(await ev(`document.getElementById('wf-input-name').getAttribute('aria-describedby') || ''`), /-e\b/, `${tag}: and described by the message`);
            await ev(`(() => { const n = document.getElementById('wf-input-name'); n.value = 'nightly-build'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            assert.equal(await ev(`document.getElementById('wf-input-name').hasAttribute('aria-invalid')`), false, `${tag}: typing clears the mark`);
            await ev(`document.querySelector('#wf-steps-editor .wf-step-name-input').value = ''; true`); await save();
            e = await err(); a = await state();
            assert.ok(/Step 1 needs a name/.test(e.text) && /wf-step-name-input/.test(a.cls), `${tag}: an empty step name is said and focus goes to it (${JSON.stringify([e.text, a])})`);
            await ev(`(() => { document.querySelector('#wf-steps-editor .wf-step-name-input').value = 's1'; document.querySelector('#wf-steps-editor .wf-step-content').value = ''; return true; })()`); await save();
            e = await err(); a = await state();
            assert.ok(/needs a/.test(e.text) && /wf-step-content/.test(a.cls), `${tag}: an empty command is said and focus goes to it (${JSON.stringify([e.text, a])})`);
            await ev(`import(${S} + 'workflows.js').then(m => m.hideWorkflowCreateModal()).then(() => true)`);

            // the job editor
            await ev(`window.openAutomationsFolder('jobs'); true`);
            await waitFor(`!!document.querySelector('#group-table-view tr[data-key="5"] button.dt-primary')`, `${tag}: jobs`, 10000); // the world serves job 5 only
            await ev(`document.querySelector('#group-table-view tr[data-key="5"] button.dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('#scheduler-detail [data-on-click="job-edit"]')`, `${tag}: job`, 10000);
            await ev(`document.querySelector('#scheduler-detail [data-on-click="job-edit"]').click(); true`);
            await waitFor(`!!document.getElementById('job-modal') && document.getElementById('job-modal').style.display === 'flex'`, `${tag}: the job editor`, 10000);
            const jsave = () => ev(`document.getElementById('job-modal-submit').click(); new Promise(r => setTimeout(r, 150)).then(() => true)`); // sleep-ok: the check and the focus settle
            const choices = await ev(`(() => { const g = id => [...document.querySelectorAll(id)].map(b => b.getAttribute('aria-pressed') + ':' + b.classList.contains('active')); const pk = document.getElementById('sched-picker'); return { presets: g('.sched-preset'), types: g('.job-type-btn'), group: pk.getAttribute('role') + ':' + pk.getAttribute('aria-labelledby'), cronName: document.getElementById('job-modal-cron').closest('label').firstChild.textContent.trim() }; })()`);
            assert.ok(choices.presets.every(x => x.split(':')[0] === x.split(':')[1]) && choices.types.every(x => x.split(':')[0] === x.split(':')[1]), `${tag}: schedule presets and the job type say which is on (${JSON.stringify(choices)})`);
            assert.equal(choices.group, 'group:sched-label', `${tag}: the schedule choices are a named group`);
            assert.equal(choices.cronName, 'Cron expression', `${tag}: the cron field has a name`);
            await ev(`document.getElementById('job-modal-name').value = ''; true`); await jsave();
            a = await state();
            assert.equal(a.id, 'job-modal-name', `${tag}: an empty job name puts focus on Name (${JSON.stringify(a)})`);
            assert.equal(await ev(`document.getElementById('job-modal-name').getAttribute('aria-invalid')`), 'true', `${tag}: and marks it`);
            await ev(`(() => { document.getElementById('job-modal-name').value = 'hourly'; document.getElementById('job-modal-cron').value = ''; return true; })()`); await jsave();
            a = await state();
            assert.equal(a.id, 'job-modal-cron', `${tag}: an empty cron shows the cron field and puts focus on it (${JSON.stringify(a)})`);
            assert.equal(await ev(`document.getElementById('job-modal-cron').getAttribute('aria-invalid')`), 'true', `${tag}: and marks it`);
            const cron = await ev(`(() => { const c = document.getElementById('cron-preview'); return { role: c.getAttribute('role'), described: (document.getElementById('job-modal-cron').getAttribute('aria-describedby') || '').split(' ').includes('cron-preview') }; })()`);
            assert.equal(cron.role, 'status', `${tag}: the Valid / Invalid cron line is a status`);
            assert.ok(cron.described, `${tag}: the cron field is described by it`);
            await ev(`import(${S} + 'job_form.js').then(m => m.hideJobModal()).then(() => true)`);
            console.log(`   ✓ ${tag}`);
        }
        console.log('PASS Workflows and Jobs: editor errors said and the field marked, cron status described');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
