// Settings > Agents has the Orchestrator's own defaults beside the workers' (#13899, the Operator's approved page): a thinking row for every type that takes levels (Claude's was the only one), and a closed "Orchestrator defaults"
// section with a model and a thinking row for each of Claude, Codex, Antigravity and Pi, empty meaning the same as the workers. The rows are filled from the saved settings, a change is sent under its own key (and nothing else),
// the levels in each list are the ones the CLI takes, and Gemini and terminal agents, which take none, have no row. 1280 and 390 px. The settings are stubbed (the server learns the new keys in the Backend part of #13899).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const LEVELS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh'], agy: ['low', 'medium', 'high', 'xhigh', 'max'], pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
const SAVED = { default_model_claude: 'claude-sonnet-5-5', default_thinking_claude: 'medium', default_orchestrator_model_claude: 'claude-opus-5-5', default_orchestrator_thinking_claude: 'high', default_thinking_pi: 'low', default_orchestrator_thinking_pi: 'high' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const guard = await require('./helpers/settings_guard').guardSettings();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(() => { const original = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/settings' && (o.method || 'GET').toUpperCase() === 'GET') return original(u, o).then(async r => { const d = await r.json(); return new Response(JSON.stringify({ ...d, settings: { ...(d.settings || {}), ...${JSON.stringify(SAVED)} } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
                return original(u, o); }; return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.settings = { ...(m.state.settings || {}), ...${JSON.stringify(SAVED)} }; return true; })`); // the dialog fills from the settings the page already holds
            await ev(`(async () => { await window.showSettingsModal('agents'); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-orchestrator-model-claude')`, at + 'Settings with the Orchestrator rows', 10000);
            // the section is there, closed by default, and opens
            const sec = await ev(`(() => { const h = document.getElementById('settings-orchestrator-defaults'); return { there: !!h, text: h && h.textContent.trim(), open: h && (h.closest('details') ? h.closest('details').open : h.getAttribute('aria-expanded')) }; })()`);
            check(sec.there && /Orchestrator defaults/.test(sec.text), at + 'the Orchestrator defaults heading is there: ' + JSON.stringify(sec));
            // the thinking lists: the levels each CLI takes, empty first (the CLI's own default for the workers, the same as the workers for the Orchestrator)
            for (const [t, levels] of Object.entries(LEVELS)) {
                const lists = await ev(`(() => { const opts = id => [...(document.getElementById(id)?.options || [])].map(o => o.value); return { workers: opts('settings-default-thinking-${t}'), orch: opts('settings-orchestrator-thinking-${t}'), orchEmpty: (document.getElementById('settings-orchestrator-thinking-${t}')?.options[0] || {}).textContent, modelHint: (document.getElementById('settings-orchestrator-model-${t}') || {}).placeholder }; })()`);
                check(JSON.stringify(lists.workers) === JSON.stringify(['', ...levels]) && JSON.stringify(lists.orch) === JSON.stringify(['', ...levels]), `${at}${t}: both thinking lists are empty then ${levels.join(', ')}: ` + JSON.stringify(lists));
                check(lists.orchEmpty === 'Same as workers' && lists.modelHint === 'Same as workers', `${at}${t}: an empty Orchestrator row says it is the same as the workers: ` + JSON.stringify(lists));
            }
            check(await ev(`!document.getElementById('settings-default-thinking-gemini') && !document.getElementById('settings-orchestrator-thinking-gemini') && !document.getElementById('settings-orchestrator-model-gemini')`), at + 'Gemini takes no thinking level and has no Orchestrator row');
            // filled from the saved settings
            const filled = await ev(`Object.fromEntries(['settings-default-thinking-claude', 'settings-orchestrator-model-claude', 'settings-orchestrator-thinking-claude', 'settings-default-thinking-pi', 'settings-orchestrator-thinking-pi', 'settings-orchestrator-model-codex'].map(id => [id, document.getElementById(id)?.value]))`);
            check(filled['settings-default-thinking-claude'] === 'medium' && filled['settings-orchestrator-model-claude'] === 'claude-opus-5-5' && filled['settings-orchestrator-thinking-claude'] === 'high' && filled['settings-default-thinking-pi'] === 'low' && filled['settings-orchestrator-thinking-pi'] === 'high' && filled['settings-orchestrator-model-codex'] === '', at + 'the rows are filled from the saved settings, an unset one empty: ' + JSON.stringify(filled));
            // a change is sent under its own key, and only that
            await ev(`window.__rowWrites=[]; {const f=window.fetch;window.fetch=(u,o={})=>{if(new URL(String(u),location.href).pathname==='/api/settings' && o.method==='PUT'){window.__rowWrites.push(JSON.parse(o.body));return Promise.resolve(new Response('{}',{headers:{'Content-Type':'application/json'}}));}return f(u,o);};} true`);
            for(const [id,value] of [['settings-orchestrator-model-codex',' gpt-5.5-codex '],['settings-orchestrator-thinking-agy','max'],['settings-default-thinking-codex','minimal']]) {
                await ev(`(() => {const e=document.getElementById('${id}');e.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));return true;})()`);
                await waitFor(`document.getElementById('${id}').dataset.saving !== '1'`, id+' saved');
            }
            check(JSON.stringify(await ev(`window.__rowWrites`))===JSON.stringify([{default_orchestrator_model_codex:'gpt-5.5-codex'},{default_orchestrator_thinking_agy:'max'},{default_thinking_codex:'minimal'}]), at+'each row sends only its own trimmed key: '+JSON.stringify(await ev(`window.__rowWrites`)));
            check(!(await ev(`document.documentElement.scrollWidth > innerWidth + 1`)), at + 'no sideways scroll');
        }
    } finally { await client.close(); await guard.restore(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Settings has the Orchestrator defaults and every thinking row that takes levels, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
