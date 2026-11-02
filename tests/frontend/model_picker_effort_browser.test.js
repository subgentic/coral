// The model picker says where its list came from and shows one model once (#12053, the operator): agy's own list has a model per effort ("Claude Sonnet 5.5 (Low)", "(High)"), which sat beside a Thinking row that
// offers the same levels, and nothing said which CLI or list it was. The variants of one model are listed together under its name with the level beside it, a note says the level is the Thinking setting too, and a line
// under the list says its source (the CLI's own, or Coral's short list when the CLI could not list). Nothing about the launch changes: the model's id is what is passed. The page's picker with the list route stubbed.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const run = (type, data) => ev(`(async () => {
            const original = window.fetch;
            window.fetch = (u, o = {}) => new URL(String(u), location.origin).pathname === '/api/agents/models' ? Promise.resolve(new Response(JSON.stringify(${JSON.stringify(data)}), { status: 200, headers: { 'Content-Type': 'application/json' } })) : original(u, o);
            const m = await import(${S} + 'model_picker.js');
            document.getElementById('zz-box')?.remove();
            const box = document.createElement('div'); box.id = 'zz-box'; box.innerHTML = '<select class="acf-agent-type"><option value="' + ${JSON.stringify(type)} + '" selected>x</option></select><label>Model ' + m.modelPickerHtml() + '<input type="text" class="acf-model"></label>'; document.body.append(box);
            m.wireModelPicker(box); await m.loadModelPicker(box, ${JSON.stringify(type)});
            const sel = box.querySelector('.acf-model-select'), groups = [...sel.querySelectorAll('optgroup')].map(g => ({ label: g.label, options: [...g.querySelectorAll('option')].map(o => o.textContent) }));
            const loose = [...sel.children].filter(c => c.tagName === 'OPTION').map(o => o.textContent);
            const pick = v => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); return box.querySelector('.acf-model-effort').textContent; };
            const out = { groups, loose, source: box.querySelector('.acf-model-source').textContent, noteBefore: box.querySelector('.acf-model-effort').textContent };
            const first = box.querySelector('optgroup option'); if (first) out.noteLow = pick(first.value);
            const plain = [...sel.querySelectorAll(':scope > option')].find(o => o.value && !/^__/.test(o.value) && !/Default|Other|Add/.test(o.textContent)); if (plain) out.notePlain = pick(plain.value);
            window.fetch = original; box.remove(); return out; })()`);
        const agy = await run('agy', { source: 'account', models: [
            { value: 'claude-sonnet-5-5-low', display_name: 'Claude Sonnet 5.5 (Low)' }, { value: 'claude-sonnet-5-5-high', display_name: 'Claude Sonnet 5.5 (High)' },
            { value: 'gemini-3.8-flash-low', display_name: 'Gemini 3.8 Flash (Low)' }, { value: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)' }, { value: 'gpt-oss-120b', display_name: 'GPT-OSS 120B' } ], thinking: ['low', 'medium', 'high'] });
        check(JSON.stringify(agy.groups.map(g => g.label)) === JSON.stringify(['Claude Sonnet 5.5', 'Gemini 3.8 Flash']), 'the variants of one model sit under its name: ' + JSON.stringify(agy));
        if (!agy.groups.length) { console.error('no groups: ' + JSON.stringify(agy)); process.exit(1); }
        check(JSON.stringify(agy.groups[0].options) === JSON.stringify(['Claude Sonnet 5.5 · Low', 'Claude Sonnet 5.5 · High']), 'each shows its level beside the name: ' + JSON.stringify(agy.groups[0]));
        check(agy.loose.includes('GPT-OSS 120B'), 'a model with no level stays as it was: ' + JSON.stringify(agy.loose));
        check(/Antigravity account/.test(agy.source), 'the source line names the CLI: ' + agy.source);
        check(/Low effort is part of this model's name.*Thinking/.test(agy.noteLow || ''), 'choosing a variant says the level is the Thinking setting too: ' + agy.noteLow);
        check(agy.notePlain === '' || agy.notePlain === undefined, 'a model with no level says nothing about effort: ' + agy.notePlain);
        const builtin = await run('agy', { source: 'builtin', models: [{ value: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] });
        check(/Coral's own list: Antigravity did not list its models/.test(builtin.source) && builtin.groups.length === 0, 'Coral\'s short list says so and groups nothing: ' + JSON.stringify(builtin));
        const claude = await run('claude', { source: 'account', models: [{ value: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] });
        check(/Claude account/.test(claude.source), 'another CLI names itself: ' + claude.source);
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('model_picker_effort_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
