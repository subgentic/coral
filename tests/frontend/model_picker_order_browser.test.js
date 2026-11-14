// The model picker puts the newest of each family first and the older versions under "Older models" (#17196 item 2, walk 51: Sonnet 5.5 / Sonnet 5, Opus 5.5 / Opus 5 / 4.8 and no hint which to take).
// The CLI's own list is kept whole: Coral only orders it, and says nothing is "current". A model with no family and version stays where it was. The page's picker with the list route stubbed.
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
        const list = await run('claude', { source: 'account', models: [
            { value: 'default', display_name: 'Default (recommended)' },
            { value: 'opus-4-8', display_name: 'Opus 4.8' }, { value: 'opus-5', display_name: 'Opus 5' }, { value: 'opus-5-5', display_name: 'Opus 5.5' },
            { value: 'sonnet-5', display_name: 'Sonnet 5' }, { value: 'sonnet-5-5', display_name: 'Sonnet 5.5' }, { value: 'haiku-5-5', display_name: 'Haiku 5.5' }, { value: 'mystery', display_name: 'Mystery model' } ] });
        check(JSON.stringify(list.loose.filter(t => !/^(Default|Other|Add)/.test(t))) === JSON.stringify(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Mystery model']), 'the newest of each family is listed first, a model with no family stays: ' + JSON.stringify(list.loose));
        check(list.groups.length === 1 && list.groups[0].label === 'Older models' && JSON.stringify(list.groups[0].options) === JSON.stringify(['Opus 4.8', 'Opus 5', 'Sonnet 5']), 'older versions are under Older models, none dropped: ' + JSON.stringify(list.groups));
        check(![...list.loose, ...list.groups.flatMap(g => g.options)].some(t => /current|latest/i.test(t)), 'Coral labels nothing current');
        const one = await run('claude', { source: 'account', models: [{ value: 'opus-5-5', display_name: 'Opus 5.5' }, { value: 'sonnet-5-5', display_name: 'Sonnet 5.5' }] });
        check(one.groups.length === 0, 'one version of each: no Older models group: ' + JSON.stringify(one.groups));
        const dir = process.env.CORAL_SCREENSHOT_DIR;
        if (dir) { await ev(`(async () => { const m = await import(${S} + 'model_picker.js'); const box = document.createElement('div'); box.id = 'zz-shot'; box.style.cssText = 'position:fixed;left:20px;top:20px;width:340px;z-index:99999;background:#111;padding:12px'; box.innerHTML = '<select class="acf-agent-type" hidden><option value="claude" selected>x</option></select><label>Model ' + m.modelPickerHtml() + '<input type="text" class="acf-model"></label>'; document.body.append(box); m.wireModelPicker(box); const o = window.fetch; window.fetch = (u, x) => new URL(String(u), location.origin).pathname === '/api/agents/models' ? Promise.resolve(new Response(JSON.stringify({ source: 'account', models: ${JSON.stringify([{ value: 'opus-4-8', display_name: 'Opus 4.8' }, { value: 'opus-5', display_name: 'Opus 5' }, { value: 'opus-5-5', display_name: 'Opus 5.5' }, { value: 'sonnet-5', display_name: 'Sonnet 5' }, { value: 'sonnet-5-5', display_name: 'Sonnet 5.5' }, { value: 'haiku-5-5', display_name: 'Haiku 5.5' }])} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : o(u, x); await m.loadModelPicker(box, 'claude'); window.fetch = o; box.querySelector('select.acf-model-select').size = 12; return true; })()`);
            require('fs').mkdirSync(dir, { recursive: true }); require('fs').writeFileSync(`${dir}/model-list.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; } else console.log('PASS model list: newest first, older under Older models');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
