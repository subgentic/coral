// Walk 12's dark polish at 1280 (#15246), through the real modules in the page:
//   - the model list names a model with its version ("Sonnet 5.5", not "Sonnet") and does not offer a second "Default" beside the picker's own (the CLI's "Default (recommended)" is the model it is);
//   - the Who column of a task row says the person's name beside the circle, and is still one image named in words;
//   - the board's note about a required goal is a sentence, and the step 3 goal switch says what it will do in plain words.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');


(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: require('./test_base').BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        const imp = f => `import((window.__coralStatic || '/static/') + ${JSON.stringify(f)})`;

        console.log('1. A model with its version; no second Default');
        const names = await ev(`${imp('model_picker.js')}.then(m => [
            m.modelName({ value: 'default', display_name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' }),
            m.modelName({ value: 'sonnet', display_name: 'Sonnet', description: 'Sonnet 5.5 · Fast and capable' }),
            m.modelName({ value: 'opus', display_name: 'Opus 5.5', description: 'For complex work' }),
            m.modelName({ value: 'haiku', display_name: 'Haiku' }),
            m.modelName({ value: 'x', display_name: 'Sonnet', description: 'A fast model' })])`);
        assert.deepEqual(names, ['Opus 5.5 (recommended)', 'Sonnet 5.5', 'Opus 5.5', 'Haiku', 'Sonnet'], 'the names: ' + JSON.stringify(names));

        console.log('2. The Who cell has the name beside the circle');
        const who = await ev(`${imp('tasks_view.js')}.then(m => { const c = m.whoCell({ id: 1, title: 't', status: 'in_progress', assigned_to: 'Lead Developer' }); return { name: c.querySelector('.dt-person-name')?.textContent, circle: c.querySelector('.dt-avatar')?.textContent, label: c.getAttribute('aria-label'), role: c.getAttribute('role'), nameHidden: c.querySelector('.dt-person-name')?.getAttribute('aria-hidden') }; })`);
        assert.deepEqual(who, { name: 'Lead Developer', circle: 'L', label: 'Lead Developer', role: 'img', nameHidden: 'true' }, JSON.stringify(who));

        console.log('3. The words');
        const note = await ev(`${imp('goal_words.js')}.then(m => m.requireGoalNote)`);
        assert.equal(note, 'Every task on this board needs a goal.');
        console.log('PASS walk 12 polish');
    } finally { await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
