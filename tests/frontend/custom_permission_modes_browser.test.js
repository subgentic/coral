// Custom permission modes (#15950): Settings > Agents > Custom permission modes (a name, an agent type, the flags one per line) and the pickers that list them. Against the real server: a mode is added
// and saved with Apply, a flag that is not on the CLI's list is refused with its line, a mode that turns the prompts off says so, the mode shows in the New agent form for its CLI only (after the built-in
// ones, flags as its tip), and the launch names it ("custom:<id>", no flags typed by the form). 1440 and 390. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { nextFrame } = require('./helpers/wait').bind(ev);
    const guard = await guardSettings();
    const api = async (method, body) => ev(`fetch('/api/custom-modes', { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then(async r => ({ status: r.status, body: await r.json() }))`);
    const clear = () => api('PUT', { modes: [] });
    const openSettings = async () => { await ev(`window.showSettingsModal('agents'); true`); await waitFor(`!!document.querySelector('#settings-custom-modes [data-cpm-add]')`, 'the custom permission modes block and its Add button', 8000); };
    const fillForm = async (type, name, flags) => {
        await ev(`document.querySelector('#settings-custom-modes [data-cpm-add]').click(); true`);
        await waitFor(`!!document.getElementById('cpm-name')`, 'the form');
        await ev(`(() => { const t = document.getElementById('cpm-type'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('cpm-name').value = ${JSON.stringify(name)}; const f = document.getElementById('cpm-flags'); f.value = ${JSON.stringify(flags)}; f.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#settings-custom-modes .cm-form .sv-save').click(); return true; })()`);
    };
    const err = () => ev(`(() => { const e = document.getElementById('cpm-flags') && document.getElementById('cpm-flags').closest('.sv-row').querySelector('.sv-error'); return e && !e.hidden ? e.textContent : ''; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const view of [{ w: 1440, h: 900, phone: false }, { w: 390, h: 844, phone: true }]) {
            await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await clear();
            await openSettings();
            const at = `${view.w}: `;
            // a flag that is not a permission flag is refused with the line it is on, and nothing is added
            await fillForm('claude', 'Sneaky', '--settings\n/tmp/x.json');
            assert.match(await err(), /Line 1: --settings is not a permission flag/, at + 'the refusal names the line and the flag');
            assert.equal(await ev(`document.querySelectorAll('#settings-custom-modes .cm-row[data-type]').length`), 0, at + 'nothing was added');
            await ev(`document.getElementById('cpm-flags').value = '--permission-mode\\nplan\\nhello'; document.querySelector('#settings-custom-modes .cm-form .sv-save').click(); true`);
            assert.match(await err(), /Line 3|not a flag/, at + 'a bare word is refused');
            // the form shows the command the mode would start the agent with (#15951): not while a flag is refused (it says why), and the real one once every flag is accepted
            assert.match(await ev(`document.querySelector('#settings-custom-modes .cpm-command-refused')?.textContent || ''`), /not shown until every flag is accepted/, at + 'a refused flag keeps the command from being shown');
            await ev(`(() => { const f = document.getElementById('cpm-flags'); f.value = '--permission-mode\\nplan'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`(document.querySelector('#settings-custom-modes .cpm-command .lrc-text')?.textContent || '').includes('--permission-mode plan')`, at + 'the form shows the start command', 6000);
            assert.equal(await ev(`!!document.querySelector('#settings-custom-modes .cpm-command-refused') && true`), false, at + 'no refusal line once the flags are accepted');
            assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true, at + 'the form with its command fits the page');
            await ev(`document.getElementById('cpm-flags').value = '--permission-mode\\nplan'; document.getElementById('cpm-name').value = 'Plan only'; document.querySelector('#settings-custom-modes .cm-form .sv-save').click(); true`);
            await waitFor(`document.querySelectorAll('#settings-custom-modes .cm-row[data-type="claude"]').length === 1 && !document.querySelector('#settings-custom-modes .cm-form')`, 'the mode is a row');
            assert.match(await ev(`document.querySelector('#settings-custom-modes .cm-status').textContent`), /Unsaved changes/, at + 'not saved until Apply');
            await fillForm('codex', 'Wide open', '--sandbox\ndanger-full-access\n-a\nnever');
            await waitFor(`document.querySelectorAll('#settings-custom-modes .cm-row[data-type]').length === 2`, 'a second row');
            assert.match(await ev(`document.querySelector('#settings-custom-modes .cm-row[data-type="codex"]').innerText`), /No prompts/, at + 'a mode that turns the prompts off says so');
            // Apply saves the whole list with the rest of Settings
            await ev(`Promise.resolve(window.applySettings()).then(() => true)`);
            let saved;
            await waitFor(`fetch('/api/custom-modes').then(r => r.json()).then(d => { window.__cpm = d; return d.modes.length === 2; })`, 'both saved');
            saved = await api('GET');
            const plan = saved.body.modes.find(m => m.name === 'Plan only'), wide = saved.body.modes.find(m => m.name === 'Wide open');
            assert.deepEqual(plan.flags, ['--permission-mode', 'plan'], at + 'the flags are saved one token each');
            assert.equal(wide.risky, true, at + 'the server marks the risky one');
            assert.match(plan.id, /^[a-z0-9]{16}$/, at + 'an id made by Coral');

            // the New agent form lists the mode for its CLI only, after the built-in ones, with its flags as the tip
            await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
            await waitFor(`!!document.querySelector('#launch-agent-acf .acf-permission-mode')`, 'the form');
            await ev(`import((window.__coralStatic || '/static/') + 'custom_modes.js').then(m => m.warmCustomModes(true)).then(() => true)`);
            const opts = type => ev(`(() => { const t = document.querySelector('#launch-agent-acf .acf-agent-type'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change', { bubbles: true })); return [...document.querySelectorAll('#launch-agent-acf .acf-permission-mode optgroup[data-custom-modes] option')].map(o => [o.textContent, o.title, o.value]); })()`);
            await nextFrame();
            const claude = await opts('claude');
            assert.deepEqual(claude.map(o => o[0]), ['Plan only'], at + 'Claude lists its own custom mode');
            assert.equal(claude[0][1], 'Runs with: --permission-mode plan', at + 'the tip is the flags');
            assert.equal(claude[0][2], 'custom:' + plan.id);
            // LA2's list (#15886) draws the mode as a row after the built-in ones, its flags as the row's description, and picking the row picks the mode
            const row = await ev(`(() => { const g = document.querySelector('#launch-agent-acf .seg-modes'); if (!g) return null; const b = [...g.querySelectorAll('.seg-btn')]; const r = g.querySelector('[data-value=${JSON.stringify('custom:' + plan.id)}]'); return r && { last: b[b.length - 1] === r, name: r.querySelector('.seg-name').textContent, desc: r.querySelector('.seg-desc') && r.querySelector('.seg-desc').textContent }; })()`);
            if (row !== null) { // null: the list is off (launchFlags.modeCards), the select is the picker
                assert.deepEqual(row, { last: true, name: 'Plan only', desc: 'Runs with: --permission-mode plan' }, at + 'the mode is a row of the list, last, with its flags');
            }
            const codex = await opts('codex');
            assert.deepEqual(codex.map(o => o[0]), ['Wide open (no prompts)'], at + 'Codex lists only its own');
            assert.deepEqual(await opts('pi'), [], at + 'a CLI with none lists none');

            // picking it launches by name: the request carries permission_mode and no flags of the form's own
            await opts('claude');
            await ev(`(() => { const s = document.querySelector('#launch-agent-acf .acf-permission-mode'); s.value = ${JSON.stringify('custom:' + plan.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); window.__launch = []; const R = window.fetch; window.fetch = (u, o = {}) => { if (/\\/api\\/system\\/cli-check/.test(String(u && u.url || u))) return Promise.resolve(new Response(JSON.stringify({ found: true, version: 'v1' }), { status: 200, headers: { 'content-type': 'application/json' } })); if (/\\/api\\/sessions\\/launch$/.test(String(u && u.url || u))) { window.__launch.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ error: 'stopped by the test' }), { status: 400, headers: { 'content-type': 'application/json' } })); } return R(u, o); }; document.getElementById('launch-dir').value = '/tmp'; return true; })()`);
            await ev(`document.querySelector('#launch-step-agent [data-on-click="m-launch-session"]').click(); true`);
            await waitFor(`window.__launch && window.__launch.length === 1`, 'the launch request').catch(async e => { throw new Error(e.message + ' | ' + await ev(`JSON.stringify({ toasts: [...document.querySelectorAll('.toast-message')].map(t => t.textContent), modals: [...document.querySelectorAll('.modal')].filter(m => getComputedStyle(m).display !== 'none').map(m => (m.id || '') + ':' + m.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)), dir: document.getElementById('launch-dir').value, perm: document.querySelector('#launch-agent-acf .acf-permission-mode').value })`)); });
            const sent = await ev(`window.__launch[0]`);
            assert.equal(sent.permission_mode, 'custom:' + plan.id, at + 'the launch names the custom mode');
            assert.ok(!sent.flags || !sent.flags.some(f => /permission|plan/.test(f)), at + 'and types none of its flags');
            await ev(`window.fetch = window.fetch; true`);
            console.log('PASS ' + view.w + ': add, refuse, mark the risky one, save, list per CLI, launch by name');
        }
    } finally {
        await clear().catch(() => {}); // a page that never loaded has nothing to clear
        await guard.restore().catch(() => {});
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
