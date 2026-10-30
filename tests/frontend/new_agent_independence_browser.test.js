// The controls of New Agent are independent (the approved plan, section 1 item 4, #7374, #7376; written failing-first by QA for the redesign, #7392): choosing a thinking level, a mode or another tab changes nothing else, the
// model, the thinking level and what was typed on step 2 all stay, Next and Back keep what was typed, and only choosing a provider resets Model and Thinking (they are the provider's own lists), leaving the name, the prompt,
// the mode and the flags alone. /api/agents/models is stubbed with a few models and levels for every provider so there is something to choose. Controls by role and name (helpers/new_agent.js). 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, scenarios, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx}`); };
    const tab = async name => { await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === ${JSON.stringify(name)}); if (!t) return false; t.click(); return true; })()`); await settle(250); };
    const radio = (group, label) => ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].filter(window.__na.vis).find(e => ${group}.test(window.__na.name(e))); if (!g) return false; const r = window.__na.radios(g).find(x => ${label}.test(window.__na.radioName(x))); if (!r) return false; r.click(); return true; })()`);
    const checked = group => ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].filter(window.__na.vis).find(e => ${group}.test(window.__na.name(e))); if (!g) return null; const r = window.__na.radios(g).find(x => window.__na.isChecked(x)); return r ? window.__na.radioName(r) : ''; })()`);
    const model = () => ev(`(() => { const s = window.__na.find('select', ${N.model}); return s ? s.value : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNA(ev);
        await stubModels(ev); await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewAgent(ev, waitFor).catch(() => {});
        await ev(`(() => { const i = window.__na.find('input', ${N.folder}); if (!i) return false; i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        let name = 'Dana', prompt = 'Review every patch before it lands.';
        await S.run('what was typed on step 2 survives Next and Back (name and prompt)', async () => {
            await click('button', N.next); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
            await ev(`(() => { const n = window.__na.find('input', ${N.name}); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input', { bubbles: true })); const p = window.__na.find('textarea', ${N.prompt}); p.value = ${JSON.stringify(prompt)}; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000);
            await click('button', N.back); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'back on step 2', 4000);
            assert.equal(await ev(`window.__na.find('input', ${N.name}).value`), name, 'the name is kept');
            assert.equal(await ev(`window.__na.find('textarea', ${N.prompt}).value`), prompt, 'the prompt is kept');
            await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3 again', 4000);
        });
        await S.run('a thinking level leaves the model alone; a model leaves the thinking level alone', async () => {
            await tab('Agent'); await waitFor(`window.__na.find('select', ${N.model}) && window.__na.find('select', ${N.model}).options.length > 1`, 'a model list to choose from', 6000);
            await ev(`(() => { const s = window.__na.find('select', ${N.model}); const o = [...s.options].find(o => /small/i.test(o.value + o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            const m = await model(); assert.match(m, /small/i, 'the Small model is chosen');
            assert.ok(await radio(N.thinking, /^High$/i), 'a High thinking level to choose'); await settle(200);
            assert.equal(await model(), m, 'choosing a thinking level leaves the model alone');
            assert.equal(await checked(N.thinking), 'High');
            await ev(`(() => { const s = window.__na.find('select', ${N.model}); const o = [...s.options].find(o => /big/i.test(o.value + o.textContent)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(200);
            assert.equal(await checked(N.thinking), 'High', 'choosing another model leaves the thinking level alone');
            await ev(`(() => { const s = window.__na.find('select', ${N.model}); const o = [...s.options].find(o => /small/i.test(o.value + o.textContent)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        });
        await S.run('a mode and another tab leave the model, the thinking level, the name and the prompt alone', async () => {
            const m = await model(), t = await checked(N.thinking);
            await tab('Permissions'); assert.ok(await radio(N.mode, /^Plan/i) || await radio(N.mode, /Accept edits/i), 'a Mode to choose'); await settle(200);
            const mode = await checked(N.mode);
            await tab('Advanced'); await ev(`(() => { const f = window.__na.find('input', ${N.flags}); f.value = '--verbose'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await tab('Agent');
            assert.equal(await model(), m, 'the model survived the other tabs and the mode'); assert.equal(await checked(N.thinking), t, 'the thinking level survived');
            await tab('Permissions'); assert.equal(await checked(N.mode), mode, 'the mode survived');
            await tab('Advanced'); assert.equal(await ev(`window.__na.find('input', ${N.flags}).value`), '--verbose', 'the flags survived');
            await click('button', N.back); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
            assert.equal(await ev(`window.__na.find('input', ${N.name}).value`), name, 'the name survived step 3');
            assert.equal(await ev(`window.__na.find('textarea', ${N.prompt}).value`), prompt, 'the prompt survived step 3');
            await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000);
            await tab('Agent');
            assert.equal(await model(), m, 'the model survived Back and Next'); assert.equal(await checked(N.thinking), t, 'the thinking level survived Back and Next');
        });
        await S.run('choosing a provider resets Model and Thinking to their defaults and leaves the name, the prompt, the mode and the flags alone', async () => {
            await tab('Agent');
            const names = await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].find(e => ${N.provider}.test(window.__na.name(e))); return g ? window.__na.radios(g).map(r => ({ n: window.__na.radioName(r), c: window.__na.isChecked(r) ? 'true' : 'false' })) : null; })()`);
            assert.ok(names && names.length >= 2, 'a Provider radiogroup');
            const other = names.find(x => x.c !== 'true'); assert.ok(other, 'another provider to choose');
            const before = { model: await model() };
            await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].find(e => ${N.provider}.test(window.__na.name(e))); window.__na.radios(g).find(r => window.__na.radioName(r) === ${JSON.stringify(other.n)}).click(); return true; })()`); await settle(500);
            assert.equal(await checked(N.provider), other.n, 'the provider is chosen');
            await waitFor(`(() => { const s = window.__na.find('select', ${N.model}); return !!s && ![...s.options].some(o => /^claude-/.test(o.value)); })()`, 'the model list is the new provider\'s', 5000);
            assert.notEqual(await model(), before.model, 'the model is reset: it was the previous provider\'s');
            assert.equal(await checked(N.thinking), 'Default', 'Thinking is back to Default');
            await tab('Permissions'); assert.ok(await checked(N.mode), 'the mode is still chosen');
            await tab('Advanced'); assert.equal(await ev(`window.__na.find('input', ${N.flags}).value`), '--verbose', 'the flags stay');
            await click('button', N.back); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
            assert.equal(await ev(`window.__na.find('input', ${N.name}).value`), name, 'the name stays'); assert.equal(await ev(`window.__na.find('textarea', ${N.prompt}).value`), prompt, 'the prompt stays');
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
