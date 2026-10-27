// The New Agent and Restart Session dialogs never move or resize (#7374, #7376; IA v4 section 3 of v3): one size for every step and tab (a fixed height, the smaller of 640 px and the screen minus 32 px, a full-height sheet on a
// phone), the same rectangle on all three steps, on every tab, for each provider, in Restart, and the note a provider adds goes in a slot that is already tall enough, so choosing Claude, Codex or any other provider moves
// neither Model nor Thinking nor the dialog. Written failing-first by QA for the redesign (#7392) as a measurement: the dialog's rect at 1280x800, 390x844 and 390 at 200% text. Controls are found by role and name
// (helpers/new_agent.js). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, scenarios, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

const VIEWS = [['1280x800', 1280, 800, false, false], ['390x844', 390, 844, true, false], ['390x844 at 200% text', 390, 844, true, true]];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const rect = () => ev(`(() => { const d = window.__na.panel(); return d ? window.__na.box(d) : null; })()`);
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx}`); };
    const same = (a, b, what) => { assert.ok(a && b, `${what}: the dialog is open`); for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) <= 0.5, `${what}: dialog ${k} moved from ${a[k]} to ${b[k]}`); };
    const tab = async (name) => { await click('[role=tab]', new RegExp('^' + name + '$')); await settle(300); };
    // On a phone step 3 may use the section picker (a select named Section) instead of a visible tablist: both are the same three sections.
    const section = async (name) => {
        const sel = await ev(`!!window.__na.find('select', /section$/i)`);
        if (sel) { await ev(`(() => { const s = window.__na.find('select', /section$/i); const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(name)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(300); }
        else await tab(name);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, big] of VIEWS) {
            console.log(`${label}`);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev); await stubModels(ev);
            await ev(`document.documentElement.style.fontSize = ${big ? "'32px'" : "''"}; true`);
            let base = null;
            await S.run(`${label}: the dialog is the fixed size (desktop: 640 px or the screen minus 32; phone: a full-height sheet), and the same on step 1, 2 and 3`, async () => {
                await openNewAgent(ev, waitFor); await settle(400);
                const r1 = await rect(); assert.ok(r1, 'the New agent dialog is open'); base = r1;
                const sizeProblem = mobile ? (Math.abs(r1.h - h) <= 2 && r1.w >= w - 24 ? '' : `phone: a full-height sheet (dialog ${r1.w}x${r1.h} in ${w}x${h})`) : (Math.abs(r1.h - Math.min(640, h - 32)) <= 1 ? '' : `desktop: height min(640, ${h - 32}) (dialog is ${r1.h})`);
                await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await click('button', N.next); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000); await settle(300);
                same(base, await rect(), 'step 2');
                await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000); await settle(300);
                same(base, await rect(), 'step 3');
                assert.equal(sizeProblem, '', sizeProblem);
            });
            await S.run(`${label}: every tab of step 3 (Agent, Permissions, Advanced) has the same rectangle, and the footer is inside the screen`, async () => {
                assert.ok(base, 'step 3 reached'); 
                for (const t of N.tabs) { await section(t); same(base, await rect(), `tab ${t}`); }
                const b = await ev(`window.__na.buttons()`);
                const launch = b.find(x => N.launch.test(x.name)); assert.ok(launch, 'Launch is shown');
                assert.ok(launch.y + launch.h <= h + 1, `the footer is on screen (Launch bottom ${launch.y + launch.h} of ${h})`);
                assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), 'no sideways scroll');
            });
            await S.run(`${label}: choosing each provider moves nothing: not the dialog, not Model, not Thinking, and the note goes in a reserved polite slot`, async () => {
                await section('Agent');
                const names = await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].find(e => ${N.provider}.test(window.__na.name(e))); return g ? window.__na.radios(g).map(r => window.__na.radioName(r)) : null; })()`);
                assert.ok(names && names.length >= 3, `Provider is a radiogroup of the providers (found ${JSON.stringify(names)})`);
                const probe = () => ev(`(() => { const f = (s, rx) => { const e = window.__na.find(s, rx); return e ? window.__na.box(e) : null; }; const m = f('select', ${N.model}); const t = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].find(e => ${N.thinking}.test(window.__na.name(e))); const go = document.getElementById('launch-agent-go'); return { dialog: window.__na.box(window.__na.panel()), model: m, thinking: t ? window.__na.box(t) : null, launch: go ? window.__na.box(go) : null }; })()`);
                let slotMin = Infinity;
                const first = await probe(); assert.ok(first.model && first.thinking && first.launch, 'Model, Thinking and Launch are on the Agent tab');
                await ev(`(() => { if (window.__cliMocked) return true; window.__cliMocked = true; window.__cli = 'found'; const real = window.fetch; window.fetch = (u, o) => String(u).includes('/api/system/cli-check') ? Promise.resolve(new Response(JSON.stringify(window.__cli === 'missing' ? { found: false, install_url: 'https://docs.example.com/install', install_command: 'npm install -g example-cli' } : { found: true, version: '1.0.0', status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) : real(u, o); return true; })()`); // the CLI check answers what the suite says: found, then missing (its row is in the notes area under Thinking, so neither moves anything)
                for (const cli of ['found', 'missing']) {
                    await ev(`window.__cli = ${JSON.stringify(cli)}; true`);
                    for (const n of names) {
                        await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].find(e => ${N.provider}.test(window.__na.name(e))); window.__na.radios(g).find(r => window.__na.radioName(r) === ${JSON.stringify(n)}).click(); return true; })()`);
                        await settle(300);
                        const p = await probe(); same(first.dialog, p.dialog, `provider ${n} (CLI ${cli}): dialog`);
                        slotMin = Math.min(slotMin, await ev(`document.getElementById('launch-note-slot').offsetHeight`));
                        for (const k of ['model', 'thinking', 'launch']) { assert.ok(p[k], `provider ${n} (CLI ${cli}): ${k} is shown`); for (const c of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(first[k][c] - p[k][c]) <= 0.5, `provider ${n} (CLI ${cli}): ${k} ${c} moved from ${first[k][c]} to ${p[k][c]}`); } // Provider, Model, Thinking and Launch never move, at any width: the notes have their room at the end of the pane, under Thinking (#8528, the operator's no-shift rule #8497)
                    }
                }
                if (mobile) assert.ok(slotMin <= 24, `on a phone an empty notes slot takes no room (the smallest slot seen was ${slotMin}px tall)`);
                assert.ok(await ev(`(() => { const d = window.__na.dialog(); return [...d.querySelectorAll('[aria-live=polite]')].some(e => e.getClientRects().length > 0 || e.offsetHeight > 0); })()`), 'a polite live region holds the provider note');
            });
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);

            // Restart: one screen, the same rectangle as New agent, on all four tabs, and the Provider warning moves nothing
            await S.run(`${label}: Restart Session is the same rectangle on its persona step and its three tabs (Model, Permissions, Advanced), and the Model tab has the provider choice`, async () => {
                await ev(`window.__m.add('qa-agent', 'A', 3, { sleeping: false }); T.render.renderLiveSessions(T.state.liveSessions); true`);
                await select('qa-agent');
                await ev(`(async () => { await window.restartSession(); return true; })()`);
                await waitFor(`!!window.__na.dialog() && /^Restart/i.test(window.__na.name(window.__na.dialog()))`, 'the Restart Session dialog (role=dialog named Restart Session)', 6000);
                await settle(400);
                const r0 = await rect(); same(base, r0, 'Restart opens at New agent\'s rectangle');
                await ev(`document.getElementById('restart-next').click(); true`); // step 1 is the persona page: Next opens the tabs
                await settle(200); same(base, await rect(), 'Restart step 2');
                const open = await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => x.getAttribute('aria-selected') === 'true'); return t ? window.__na.name(t) : (window.__na.find('select', /section$/i) ? window.__na.find('select', /section$/i).selectedOptions[0].textContent.trim() : null); })()`);
                assert.equal(open, 'Model', 'step 2 opens on Model');
                const names = await ev(`(() => { const tl = window.__na.dialog().querySelector('[role=tablist]'); const tabs = tl ? [...tl.querySelectorAll('[role=tab]')].filter(window.__na.vis).map(t => window.__na.name(t)) : []; return tabs.length ? tabs : [...window.__na.find('select', /section$/i).options].map(o => o.textContent.trim()); })()`);
                assert.deepEqual(names, ['Model', 'Permissions', 'Advanced'], 'Restart has three sections: the agent is fixed, so no Agent step');
                for (const t of ['Model', 'Permissions', 'Advanced']) { await section(t); same(base, await rect(), `Restart tab ${t}`); }
                await section('Model'); // #8973: Restart's Model tab has New Agent's provider picker (the agent's own provider is chosen), so a restart may switch the provider
                const pick = await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].find(e => ${N.provider}.test(window.__na.name(e))); if (!g) return null; const rs = window.__na.radios(g); return { n: rs.length, on: rs.filter(r => r.checked || r.getAttribute('aria-checked') === 'true').length }; })()`);
                assert.ok(pick && pick.n >= 2 && pick.on === 1, 'the Model tab has the provider choice, the agent\'s own provider chosen: ' + JSON.stringify(pick));
                await click('button', N.cancel); await waitFor(`!window.__na.dialog()`, 'Cancel closes Restart', 4000);
            });
            await ev(`document.documentElement.style.fontSize = ''; true`);
        }
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
