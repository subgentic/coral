// A Launch blocked by a missing CLI has the fix one tap away (Mobile and Desktop testers, #10013): New agent's CLI warning and New team step 3's reason line each get a "Set path" button that opens Settings > Agents with the CLI paths
// open and that CLI's field focused; when Settings is closed the check runs again, so the person is back in the dialog with the blocker gone (or still named). At 1280 and 390 px, 44 px high on a phone.
// Isolated dev server; the CLI check is stubbed (missing, then found). Controls by role and name (helpers/new_agent.js, helpers/new_team.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNA, N: NA, openNewAgent } = require('./helpers/new_agent');
const { install: installNT, T, N: NT, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `window.__cliFound = false; const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/system/cli-check') return Promise.resolve(new Response(JSON.stringify(window.__cliFound ? { found: true, version: '1', status: 'available' } : { found: false, status: 'missing', agent_type: p.searchParams.get('type') }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; true`;
    const setPath = scope => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' .cli-set-path')].find(e => e.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { h: Math.round(r.height), name: b.getAttribute('aria-label') }; })()`);
    const press = async (scope, why) => { await ev(`[...document.querySelectorAll(${JSON.stringify(scope)} + ' .cli-set-path')].find(e => e.getClientRects().length).click(); true`); await waitFor(`(m => !!m && getComputedStyle(m).display !== 'none')(document.getElementById('settings-modal'))`, `${why}: Settings opens`, 8000); await settle(500); };
    const settingsState = () => ev(`(() => { const d = document.getElementById('settings-cli-paths'), f = document.getElementById('settings-cli-path-claude'); return { open: !!d && d.open, focus: document.activeElement === f, fieldShown: !!f && f.getClientRects().length > 0 }; })()`);
    const closeSettings = async () => { await ev(`window.hideSettingsModal(); true`); await settle(500); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNA(ev); await installNT(ev); await stubModels(ev);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); ${STUB}`);
            // New agent, step 3: the CLI warning
            await openNewAgent(ev, waitFor);
            await ev(`(() => { const i = window.__na.find('input', ${NA.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            for (let s = 1; s < 3; s++) { await ev(`window.__na.find('button', ${NA.next}).click(); true`); await waitFor(`/Step ${s + 1} of 3/.test(window.__na.dialog() ? window.__na.dialog().textContent : '')`, `${w}: step ${s + 1}`, 6000); }
            await waitFor(`!!document.querySelector('#launch-step-agent [data-blocks-launch] .cli-set-path')`, `${w}: New agent's CLI warning has a Set path button`, 10000).catch(() => {});
            let b = await setPath('#launch-step-agent [data-blocks-launch]');
            check(!!b, 'New agent: the missing-CLI warning has a Set path button');
            if (b) {
                if (mobile) check(b.h >= 44, `New agent: Set path is 44 px high on a phone: ${b.h}`);
                await shot(`launch-set-path-agent-${w}`);
                await press('#launch-step-agent [data-blocks-launch]', 'New agent');
                const s = await settingsState();
                check(s.open && s.fieldShown && s.focus, `New agent: Settings opens with the CLI paths open and the Claude path field focused: ${JSON.stringify(s)}`);
                await shot(`launch-set-path-settings-${w}`);
                await ev(`window.__cliFound = true; true`);
                await closeSettings();
                await waitFor(`!document.querySelector('#launch-step-agent [data-blocks-launch]')`, `${w}: the blocker clears when Settings closes and the CLI is found`, 8000).catch(() => check(false, 'New agent: when Settings closes the check runs again and the blocker clears'));
                check(await ev(`!!window.__na.dialog()`), 'New agent: the dialog is still there');
            }
            // New team, step 3: the reason line (a fresh page: the CLI check is cached for 30 s, and the one above said found)
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNA(ev); await installNT(ev); await stubModels(ev);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); ${STUB}`);
            await openNewTeam(ev, waitFor);
            await T(ev, waitFor).to(3, {});
            await waitFor(`document.getElementById('launch-team-go').disabled`, `${w}: Launch team is off while the CLI is missing`, 8000);
            b = await setPath('#team-recap');
            check(!!b, 'New team: the reason line has a Set path button');
            if (b) {
                if (mobile) check(b.h >= 44, `New team: Set path is 44 px high on a phone: ${b.h}`);
                await shot(`launch-set-path-team-${w}`);
                await press('#team-recap', 'New team');
                const s = await settingsState();
                check(s.open && s.fieldShown && s.focus, `New team: Settings opens with the CLI paths open and the Claude path field focused: ${JSON.stringify(s)}`);
                await ev(`window.__cliFound = true; true`);
                await closeSettings();
                await waitFor(`!document.getElementById('launch-team-go').disabled`, `${w}: Launch team is on once the CLI is found and Settings is closed`, 8000).catch(async () => check(false, 'New team: when Settings closes the check runs again and Launch team turns on: ' + JSON.stringify(await ev(`(() => { const bl = [...document.querySelectorAll('#launch-step-team [data-blocks-launch]')].map(e => ({ id: e.id, cls: e.className, text: e.textContent.slice(0, 60), btns: [...e.querySelectorAll('button')].map(b => b.className + ':' + b.textContent) })); return { bl, go: document.getElementById('launch-team-go').disabled, found: window.__cliFound }; })()`))));
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Set path on a blocked Launch:\n  ' + problems.join('\n  '));
    console.log('PASS a Launch blocked by a missing CLI has Set path');
})().catch(e => { console.error(e); process.exit(1); });
