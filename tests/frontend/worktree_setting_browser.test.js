// Launching a team in a git worktree is experimental and off by default (#12746, the Operator: it is failing for first-time users): the New team dialog does not offer "Launch in a git worktree" even for a git
// folder until the Settings switch "Enable launch into git worktree (experimental)" is on, the switch says it is experimental and starts off, and turning it on offers the option again. At 1280 and 390 px.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server; the folder check answers is_git for every folder.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/settings' && (o.method || 'GET') === 'GET' && window.__settingsBody) return Promise.resolve(new Response(JSON.stringify({ settings: window.__settingsBody }), { status: 200, headers: { 'content-type': 'application/json' } })); if (p.pathname === '/api/filesystem/is-git') return Promise.resolve(new Response(JSON.stringify({ is_git: true, branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } })); return real(u, o); }; return true; })()`);
            const setSwitch = on => ev(`import(${S} + 'state.js').then(m => { m.state.settings = { ...(m.state.settings || {}), launch_in_worktree: ${on === true ? "'true'" : on === false ? "''" : JSON.stringify(on)} }; return true; })`); // true, false (unset), or a raw stored value such as the string 'false'
            const offered = async () => {
                await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
                await waitFor(`!!document.getElementById('launch-step-team') && getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
                await ev(`(() => { const d = document.getElementById('launch-team-dir'); d.value = '/work/a-git-repo'; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await sleep(900); // sleep-ok: the folder check is debounced 500 ms and answers over the network; there is no event for "no worktree option appeared"
                const shown = await ev(`(() => { const c = document.getElementById('launch-team-worktree'), r = c && c.closest('.sv-row'); return !!r && !r.hidden && r.getClientRects().length > 0; })()`);
                await ev(`window.hideLaunchModal(); true`);
                return shown;
            };
            await setSwitch(false);
            check(`${tag}: switch off (the default): a git folder is not offered a worktree`, (await offered()) === false);
            await setSwitch(true);
            check(`${tag}: switch on: a git folder is offered it`, (await offered()) === true);
            await setSwitch(false);
            check(`${tag}: switched off again: not offered`, (await offered()) === false);
            await setSwitch('false');
            check(`${tag}: the stored string "false" is off: not offered`, (await offered()) === false);
            await setSwitch(true);
            // the worktree box ticked, then the switch turned off and the folder looked at again: the option hides and its tick is reset, so a launch never carries a stale worktree (#12759)
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
            await ev(`(() => { const d = document.getElementById('launch-team-dir'); d.value = '/work/a-git-repo'; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await sleep(900); // sleep-ok: the folder check is debounced 500 ms and answers over the network
            await ev(`(() => { const c = document.getElementById('launch-team-worktree'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            check(`${tag}: ticked while the switch is on`, await ev(`document.getElementById('launch-team-worktree').checked === true`));
            await setSwitch(false);
            await ev(`(() => { const d = document.getElementById('launch-team-dir'); d.value = '/work/another-repo'; d.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await sleep(900); // sleep-ok: same debounce and answer
            check(`${tag}: the switch turned off: the option hides and its tick is reset, not left for a launch to carry`, await ev(`(() => { const c = document.getElementById('launch-team-worktree'), r = c.closest('.sv-row'); return r.hidden && c.checked === false; })()`));
            await ev(`window.hideLaunchModal(); true`);
            // the Settings switch: its words, and off until turned on
            await ev(`import(${S} + 'state.js').then(m => { m.state.settings = {}; return true; })`);
            await ev(`(async () => { await window.showSettingsModal(); return true; })()`);
            await waitFor(`!!document.getElementById('settings-launch-in-worktree')`, 'the switch', 8000);
            const sw = await ev(`(() => { const c = document.getElementById('settings-launch-in-worktree'), row = c.closest('.sv-row') || c.parentElement; return { checked: c.checked, text: row ? row.textContent.replace(/\\s+/g, ' ').trim() : '' }; })()`);
            check(`${tag}: the Settings switch is off by default`, sw.checked === false, JSON.stringify(sw));
            check(`${tag}: and says it is experimental, under the exact label`, sw.text.includes('Enable launch into git worktree (experimental)') && /experimental/i.test(sw.text), sw.text);
            const helpText = sw.text.replace('Enable launch into git worktree (experimental)', '');
            check(`${tag}: the one-line note beside it says experimental too`, /experimental/i.test(helpText), helpText);
            // both fills read an unset value, and the stored string "false", as off, and "true" as on: the dialog's own fill and the page's loadSettings
            const fills = await ev(`(async () => {
                const c = document.getElementById('settings-launch-in-worktree'), out = {};
                const m = await import(${S} + 'settings_core.js'), st = (await import(${S} + 'state.js')).state;
                for (const [name, body] of [['unset', {}], ['string false', { launch_in_worktree: 'false' }], ['string true', { launch_in_worktree: 'true' }]]) {
                    c.checked = name !== 'string true'; // start from the opposite of the expected answer, so a fill that does nothing fails
                    window.__settingsBody = body; await m.loadSettings();
                    out['loadSettings ' + name] = c.checked;
                    c.checked = name !== 'string true'; st.settings = body;
                    const d = await import(${S} + 'settings_fill.js'); await d._fillMachineSettings(body);
                    out['dialog fill ' + name] = c.checked;
                }
                window.__settingsBody = null; return out; })()`);
            check(`${tag}: an unset value and the string "false" read as off, "true" as on, in both fills`, !fills['loadSettings unset'] && !fills['loadSettings string false'] && fills['loadSettings string true'] && !fills['dialog fill unset'] && !fills['dialog fill string false'] && fills['dialog fill string true'], JSON.stringify(fills));
            await ev(`(() => { const x = document.querySelector('#settings-modal .close, #settings-modal [data-on-click="settings-close"], #settings-modal .modal-close'); if (x) x.click(); return true; })()`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} worktree setting checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
