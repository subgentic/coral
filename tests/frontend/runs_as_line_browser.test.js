// The "Runs as" line (#15885, LA1a of the Settings / New agent review, guidelines 4.13 and 4.8), at 1440 and 390 px, dark and light, and at 200% text:
//  - above the footer, one group named "Runs as" with Provider, Model, Thinking and Permission mode as four compact controls, each showing the value the form (and so the launch) holds, the Settings default until changed;
//  - a change in a control is a change in the launch: the form's field and its config follow (provider, model, thinking, mode);
//  - a risky mode turns its control amber and the warning is under the line; the old read-only sentence ("..., default model, Auto mode") is gone;
//  - one line on a computer, two at 390 px; nothing scrolls sideways; a control is 32 px tall on a computer and 44 on a phone.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server, the CLI checks and the model lists stood in.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, N, stubModels } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the card redraws over a frame or two after a key or a click
    const press = async (key, vk) => { await Input.dispatchKeyEvent({ type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk }); await Input.dispatchKeyEvent({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk }); await settle(300); };
    // The page's own fetches, stood in: Claude, Codex and Pi installed, Antigravity not; Claude's saved default model; Antigravity (when it is installed) has no thinking levels.
    const stub = (missing, agyHasNoLevels, refused = []) => ev(`(() => { const R = window.fetch;
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/settings' && (!o.method || o.method === 'GET')) return R(u, o).then(async r => { const d = await r.json(); d.settings = { ...(d.settings || {}), default_model_claude: 'claude-big' }; return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); });
            if (${JSON.stringify(!!agyHasNoLevels)} && url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'agy') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'agy', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'agy-big', display_name: 'agy Big' }], thinking: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            if (url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'pi') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'pi', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'pi-big', display_name: 'pi Big', efforts: ['off', 'minimal', 'low', 'medium'] }], thinking: ['off', 'minimal', 'low', 'medium'] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); };
        return true; })()`).then(() => require('./helpers/new_agent').stubCliChecks(ev, missing, [], refused));
    const open = async (w, h, mobile, theme, missing, agyNoLevels, fontPx, refused = []) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); ${fontPx ? `document.documentElement.style.setProperty('font-size', '${fontPx}px', 'important');` : ''} true`);
        await stubModels(ev); await stub(missing, agyNoLevels, refused);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } window._launchStage('agent'); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        await settle(400);
    };
    const READ = `(() => { const r = document.getElementById('launch-recap'), l = r && r.querySelector('.runs-as'), vis = e => e && e.getClientRects().length > 0, acf = document.getElementById('launch-agent-acf');
        const ctls = l ? [...l.querySelectorAll('.runs-as-ctl')].filter(vis) : [], box = e => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
        const f = s => acf.querySelector(s), val = k => { const c = l && l.querySelector('.runs-as-' + k + '-field'); return c ? c.value : null; };
        const cfg = window.getAgentConfig('launch-agent-acf'), note = r && r.querySelector('.launch-recap-note'), modeCtl = l && l.querySelector('.runs-as-mode .runs-as-field');
        return { group: l ? l.getAttribute('role') + ':' + l.getAttribute('aria-label') : null, names: ctls.map(c => c.querySelector('.runs-as-name').textContent), boxes: ctls.map(c => box(c.querySelector('.runs-as-field'))),
            provider: val('provider'), model: val('model'), thinking: val('thinking'), mode: val('mode'), fType: f('.acf-agent-type').value, fModel: f('.acf-model').value, fThinking: (f('.acf-thinking') || {}).value, fMode: f('.acf-permission-mode').value,
            cfg: { agentType: cfg.agentType, model: cfg.model, mode: cfg.permissionMode }, risky: !!(l && l.querySelector('.runs-as-risky')), note: note ? note.textContent : '', noteAmber: note ? getComputedStyle(note).color : '', plainColor: r ? getComputedStyle(r).color : '',
            modeBorder: modeCtl ? getComputedStyle(modeCtl).borderTopColor : '', otherBorder: l && l.querySelector('.runs-as-provider .runs-as-field') ? getComputedStyle(l.querySelector('.runs-as-provider .runs-as-field')).borderTopColor : '',
            sentence: /default model,|, [A-Za-z ]+ mode$/.test(r ? r.firstChild && r.textContent : ''), pageSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, recapBox: r && box(r) }; })()`;
    const set = (key, v, type = 'change') => ev(`(() => { const c = document.querySelector('#launch-recap .runs-as-${key}-field'); c.value = ${JSON.stringify(v)}; c.dispatchEvent(new Event(${JSON.stringify(type)}, { bubbles: true })); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme, fontPx] of [[1440, 900, false, 'dark'], [1440, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light'], [1440, 900, false, 'light', 32], [390, 844, true, 'dark', 32]]) {
            const tag = `${w}px ${theme}${fontPx ? ' 200%' : ''}`;
            await open(w, h, mobile, theme, ['agy'], false, fontPx);
            let d = await ev(READ);
            check(d.group === 'group:Runs as', `${tag}: one group named Runs as: ${d.group}`);
            check(JSON.stringify(d.names) === JSON.stringify(['Provider', 'Model', 'Thinking', 'Permission mode']), `${tag}: Provider, Model, Thinking, Permission mode: ${JSON.stringify(d.names)}`);
            check(d.provider === d.fType && d.model === d.fModel && d.thinking === d.fThinking && d.mode === d.fMode, `${tag}: each control shows its field's value: ${JSON.stringify([d.provider, d.fType, d.model, d.fModel, d.thinking, d.fThinking, d.mode, d.fMode])}`);
            check(d.model === 'claude-big', `${tag}: the model is Settings' default: ${d.model}`);
            check(d.cfg.agentType === d.provider && d.cfg.model === d.model && d.cfg.mode === d.mode, `${tag}: the launch has the line's values: ${JSON.stringify(d.cfg)}`);
            check(!d.sentence, `${tag}: the read-only sentence is gone`);
            const tops = [...new Set(d.boxes.map(b => Math.round(b.y / 8)))].length;
            if (!mobile && !fontPx) check(tops === 1, `${tag}: one line on a computer: ${JSON.stringify(d.boxes)}`);
            if (mobile && !fontPx) check(tops === 2, `${tag}: two lines at 390 px: ${JSON.stringify(d.boxes)}`);
            check(d.boxes.every(b => b.h >= (mobile ? 44 : 32)), `${tag}: a control is ${mobile ? 44 : 32} px or more: ${JSON.stringify(d.boxes.map(b => b.h))}`);
            check(!d.pageSideways && d.boxes.every(b => b.x >= 0 && b.x + b.w <= w), `${tag}: nothing scrolls sideways: ${JSON.stringify(d.boxes)}`);
            if (fontPx) continue;
            // a change in the line is a change in the launch
            await set('mode', 'plan'); await settle(200);
            d = await ev(READ); check(d.fMode === 'plan' && d.cfg.mode === 'plan' && !d.risky, `${tag}: Plan in the line is Plan in the launch: ${JSON.stringify([d.fMode, d.cfg.mode, d.risky])}`);
            await set('model', 'claude-small', 'input'); await settle(200);
            d = await ev(READ); check(d.fModel === 'claude-small' && d.cfg.model === 'claude-small', `${tag}: a model typed in the line is the launch's: ${JSON.stringify([d.fModel, d.cfg.model])}`);
            const lvl = await ev(`[...document.querySelectorAll('#launch-recap .runs-as-thinking-field option')].map(o => o.value)`);
            if (lvl.length > 1) { await set('thinking', lvl[lvl.length - 1]); await settle(200); d = await ev(READ); check(d.fThinking === lvl[lvl.length - 1] && d.thinking === lvl[lvl.length - 1], `${tag}: thinking follows: ${JSON.stringify([d.fThinking, d.thinking])}`); }
            // a risky mode: amber, and the warning is under the line
            await set('mode', 'bypassPermissions'); await settle(300);
            d = await ev(READ);
            check(d.risky && d.modeBorder !== d.otherBorder, `${tag}: a risky mode turns its control amber: ${JSON.stringify([d.risky, d.modeBorder, d.otherBorder])}`);
            check(/\u26a0/.test(d.note) && d.cfg.mode === 'bypassPermissions', `${tag}: the warning is under the line: ${JSON.stringify([d.note, d.cfg.mode])}`);
            check(d.noteAmber !== d.plainColor, `${tag}: the warning is amber: ${d.noteAmber} vs ${d.plainColor}`);
            await set('mode', 'plan'); await settle(200);
            d = await ev(READ); check(!d.risky && !d.note.includes('\u26a0'), `${tag}: a safe mode clears the amber and the warning: ${JSON.stringify([d.risky, d.note])}`);
            // risk is the mode's own record (#16057): a custom mode flagged risky warns whatever its words say, and words that say "isolated" do not make a safe mode risky
            const custom = (value, risky, note) => ev(`(() => { const f = document.querySelector('#launch-agent-acf .acf-permission-mode'); for (const o of [...f.options].filter(o => o.dataset.custom)) o.remove(); const o = document.createElement('option'); o.value = ${JSON.stringify(value)}; o.textContent = 'Custom'; o.dataset.custom = '1'; ${risky ? "o.dataset.risky = '1';" : ''} o.dataset.note = ${JSON.stringify(note)}; f.append(o); f.value = o.value; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await custom('custom-risky', true, 'Runs everything on this machine'); await settle(300);
            d = await ev(READ); check(d.risky && d.noteAmber !== d.plainColor, `${tag}: a custom mode marked risky warns (amber control and note) with no pattern in its words: ${JSON.stringify([d.risky, d.noteAmber, d.plainColor])}`);
            await custom('custom-safe', false, 'Reads files in an isolated copy'); await settle(300);
            d = await ev(READ); check(!d.risky && !d.note.includes('\u26a0'), `${tag}: the word isolated alone does not make a mode risky: ${JSON.stringify([d.risky, d.note])}`);
            await ev(`(() => { const f = document.querySelector('#launch-agent-acf .acf-permission-mode'); f.value = 'plan'; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(200);
            // the provider
            await set('provider', 'codex'); await settle(500);
            d = await ev(READ); check(d.fType === 'codex' && d.cfg.agentType === 'codex' && d.provider === 'codex', `${tag}: Codex in the line is Codex in the launch: ${JSON.stringify([d.fType, d.cfg.agentType, d.provider])}`);
            check(d.names.includes('Permission mode'), `${tag}: Codex has its mode: ${JSON.stringify(d.names)}`);
        }
        if (problems.length) { console.error('FAILED:\n - ' + problems.join('\n - ')); process.exitCode = 1; } else console.log('\nPASS the Runs as line: four controls, the launch follows them, a risky mode is amber');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
