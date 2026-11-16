// New agent: the hint under the Model select does not push the Thinking row down (#16357, walk 16339: about 18 px when a model's note appeared). In the Agent tab of the last step, at 1280 and 390 px, the Thinking
// row's top is the same with the model the form opens on and after each other model in the list is picked (each has its own id line, source line and effort line). Isolated dev server; models stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1280, 800, false, 'dark'], [390, 844, true, 'dark'], [1280, 800, false, 'light'], [390, 844, true, 'light']]) {
            const tag = `${w}px ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNA(ev);
            await stubModels(ev); await openNewAgent(ev, waitFor).catch(() => {});
            await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            for (const step of [2, 3]) {
                await ev(`(() => { const b = window.__na.find('button', ${N.next}); b.click(); return true; })()`);
                await waitFor(`/Step ${step} of 3/.test(window.__na.dialog().textContent)`, `${tag}: step ${step}`, 4000);
                await settle(200);
            }
            await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === 'Agent'); if (t) t.click(); return true; })()`);
            await settle(500);
            const top = () => ev(`(() => { const t = window.__na.dialog().querySelector('.sv-row[data-key="thinking"]'); return t && t.getClientRects().length ? Math.round(t.getBoundingClientRect().top) : null; })()`);
            const options = await ev(`[...window.__na.dialog().querySelectorAll('.acf-model-select option')].map(o => o.value)`);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await settle(200);
            const base = await top(); await shot(`agent-tab-${w}-${theme}-default`);
            if (base === null || options.length < 2) { problems.push(`${tag}: the test needs the Thinking row and two or more models: ${JSON.stringify({ base, options })}`); continue; }
            for (const v of options.filter(o => o && !o.startsWith('__'))) { // the models; Other and Add change the form on purpose
                await ev(`(() => { const s = window.__na.dialog().querySelector('.acf-model-select'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await settle(300);
                const t = await top();
                if (v === 'claude-big') await shot(`agent-tab-${w}-${theme}-model-picked`);
                if (t !== base) problems.push(`${tag}: picking ${JSON.stringify(v)} moves the Thinking row from ${base} to ${t}`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Thinking row:\n  ' + problems.join('\n  '));
    console.log('PASS the Thinking row does not move under the Model hint');
})().catch(e => { console.error(e.message); process.exit(1); });
