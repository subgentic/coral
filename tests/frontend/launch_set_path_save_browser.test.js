// After Set path and Save, the launch step is right at once (Mobile tester, #10161): the Claude tile still said "not installed" and the blocker's text stayed until a refresh, though Launch already worked. On the real isolated server:
// the Claude CLI path is set to one that cannot run, New agent's step 3 shows the blocker and the tile's mark, Set path opens Settings, the right path is saved, and when Settings closes both are drawn again from the fresh check:
// the blocker is gone, the tile's mark is gone and Launch is on. At 390 and 1280 px. The shard's own settings are put back by the settings guard.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');
const { install: installNA, N: NA, openNewAgent } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
        try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev);
            const good = await ev(`fetch('/api/settings').then(r => r.json()).then(d => d.settings.cli_path_claude || '')`);
            // The CLI check is stubbed: missing until the real Settings save has gone through, found after it (what saving a right path does on a real machine)
            await ev(`window.__cliFound = false; const real = window.fetch; window.fetch = async (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/agents/models') return new Response(JSON.stringify(window.__cliFound ? { agent_type: p.searchParams.get('type'), models: [{ value: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], refreshing: false } : { agent_type: p.searchParams.get('type'), models: [{ value: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], error: 'the CLI is not installed, or not where Settings > CLI paths says' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); if (p.pathname === '/api/system/cli-check') return new Response(JSON.stringify(window.__cliFound ? { found: true, version: '1', status: 'available', agent_type: p.searchParams.get('type') } : { found: false, status: 'missing', agent_type: p.searchParams.get('type') }), { status: 200, headers: { 'Content-Type': 'application/json' } }); const r = await real(u, o); if (p.pathname === '/api/settings' && (o.method || 'GET').toUpperCase() === 'PUT' && r.ok) setTimeout(() => { window.__cliFound = true; }, 400); return r; }; true`); // found 400 ms after the save answers, as a check that ran at the save's own moment would not see
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            await openNewAgent(ev, waitFor);
            await ev(`(() => { const i = window.__na.find('input', ${NA.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            for (let s = 1; s < 3; s++) { await ev(`window.__na.find('button', ${NA.next}).click(); true`); await waitFor(`/Step ${s + 1} of 3/.test(window.__na.dialog() ? window.__na.dialog().textContent : '')`, `${w}: step ${s + 1}`, 6000); }
            await waitFor(`!!document.querySelector('#launch-step-agent [data-blocks-launch] .cli-set-path')`, `${w}: the blocker with Set path`, 12000).catch(async e => { throw new Error(e.message + ' :: ' + JSON.stringify(await ev(`(() => { const x = document.querySelector('#launch-step-agent .acf-cli-warning, #launch-step-agent [data-blocks-launch]'); return { html: x ? x.outerHTML.slice(0, 500) : null, check: null }; })()`)) + ' :: ' + JSON.stringify(await ev(`fetch('/api/system/cli-check?type=claude').then(async r => ({ s: r.status, b: await r.text() }))`))); });
            const tile = () => ev(`(() => { const m = document.querySelector('#launch-agent-pick .launch-agent-missing'); const claude = [...document.querySelectorAll('#launch-agent-pick label')].find(l => /Claude/.test(l.textContent)); const mark = claude && claude.querySelector('.launch-agent-missing'); return { mark: mark ? mark.textContent.trim() : null, marked: !!claude && claude.classList.contains('has-mark') }; })()`);
            const modelNote = () => ev(`(() => { const n = document.querySelector('#launch-step-agent .acf-model-note, #launch-step-agent [id$="model-note"]'); return n ? n.textContent.trim() : null; })()`);
            check(/not installed, or not where Settings/.test(await modelNote() || ''), `the Model line says the CLI is not found before the fix: ${JSON.stringify(await modelNote())}`);
            const t0 = await tile();
            check(t0.mark === 'not installed' && t0.marked, `the Claude tile says not installed before the fix: ${JSON.stringify(t0)}`);
            await ev(`document.querySelector('#launch-step-agent [data-blocks-launch] .cli-set-path').click(); true`);
            await waitFor(`(m => !!m && getComputedStyle(m).display !== 'none')(document.getElementById('settings-modal'))`, `${w}: Settings opens`, 8000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the dialog fills
            await ev(`(() => { const f = document.getElementById('settings-cli-path-claude'); f.value = ${JSON.stringify(good)}; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`document.getElementById('settings-save-btn').click(); true`);
            await waitFor(`(m => !m || getComputedStyle(m).display === 'none')(document.getElementById('settings-modal'))`, `${w}: Settings closes after Save`, 10000);
            await waitFor(`!document.querySelector('#launch-step-agent [data-blocks-launch]')`, `${w}: the blocker is gone`, 10000).catch(() => check(false, 'the blocker is still there after Save, until a refresh'));
            await waitFor(`(() => { const claude = [...document.querySelectorAll('#launch-agent-pick label')].find(l => /Claude/.test(l.textContent)); const mark = claude && claude.querySelector('.launch-agent-missing'); return !!claude && !(mark && mark.textContent.trim()); })()`, `${w}: the tile's mark is gone`, 10000).catch(() => check(false, `the Claude tile still says not installed after Save: ${JSON.stringify(null)}`));
            await waitFor(`!/not installed, or not where Settings/.test((document.querySelector('#launch-step-agent .acf-model-note, #launch-step-agent [id$="model-note"]') || {}).textContent || '')`, `${w}: the Model line is drawn again from the fresh check`, 10000).catch(async () => check(false, 'the Model line still says the CLI is not installed after Save: ' + JSON.stringify(await modelNote())));
            check(await ev(`(() => { const b = window.__na.find('button', ${NA.launch}); return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; })()`), 'Launch is on');
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
        }
    } finally { await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message))); await client.close(); }
    assert.deepEqual(problems, [], 'Set path then Save:\n  ' + problems.join('\n  '));
    console.log('PASS the launch step is right after Set path and Save');
})().catch(e => { console.error(e); process.exit(1); });
