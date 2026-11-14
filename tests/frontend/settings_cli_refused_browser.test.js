// Settings > Agents says why a CLI that was found is not used (#16003, the follow-up of #15887: New agent no longer says it): under that CLI's path field, ONE short line ("Not used: ... is inside <agent>'s working
// folder (...)", the agent's name a link) and a Why? fold, and the CLI paths open so the way out (the path) is on screen. A CLI that is found, or plainly missing, has no such line. 1280 and 390 px, light and dark.
// Drives Chrome over CDP through agent_view_harness.js; the CLI check's answer is stubbed. SHOT_DIR=<dir> saves a shot of each.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const NOTE = bin => `Found but not used: ~/.local/bin/${bin} is in an agent's working folder: the agent "Security Reviewer" works in ~. Archive that agent (an asleep one counts too) or restart it in a project folder, then check again, so a launch refuses it. Install it somewhere else, or set its path in Settings > CLI paths.`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: only before a shot
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) for (const theme of ['light', 'dark']) {
            const at = `${w} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); (() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/system/cli-check') { const t = url.searchParams.get('type'); (window.__cliChecks = window.__cliChecks || []).push(t); const body = { agy: { found: false, status: 'missing', refused: "in an agent's working folder", install_note: ${JSON.stringify(NOTE('agy'))} }, pi: { found: false, status: 'missing' } }[t] || { found: true, status: 'ok' };
                    return Promise.resolve(new Response(JSON.stringify({ agent_type: t, ...body }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
            await ev(`window.__coralLive = null; (async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.liveSessions = [{ session_id: 'sr1', name: 'coral-sr1', display_name: 'Security Reviewer', board_subscriber_id: 'Security Reviewer', agent_type: 'claude', server: 'local' }]; return true; })()`); // the agent's name is a link when it is a live agent
            await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.settings = { ...(st.settings || {}), default_agent_type: 'agy' }; return true; })()`); // Antigravity is the default type: the one the line is checked for
            await ev(`window.__cliChecks = []; window.showSettingsModal('agents'); true`); // counted from here: what opening Settings asks
            await waitFor(`!!document.querySelector('#settings-pane-agents .cli-refused-why')`, `${at}: the refused line appears`, 8000);
            await waitFor(`document.querySelector('#settings-cli-paths').open && document.querySelector('#settings-pane-agents .cli-refused-why').getClientRects().length > 0`, `${at}: the paths open with the line shown`, 4000);
            const s = await ev(`(() => { const box = document.querySelector('#settings-pane-agents .cli-refused-why'), row = box.closest('.sv-row'), input = row.querySelector('input'), r = e => e.getBoundingClientRect();
                const line = box.querySelector('.provider-why-line'), fold = box.querySelector('details.provider-why'), pane = document.querySelector('#settings-pane-agents'), p = r(pane);
                return { count: document.querySelectorAll('#settings-pane-agents .cli-refused-why').length, type: box.dataset.cli, inputId: input.id, text: line.textContent, link: !!line.querySelector('a, button'), why: fold && fold.querySelector('summary').textContent,
                    open: document.querySelector('#settings-cli-paths').open, shown: box.getClientRects().length > 0, inside: r(box).right <= p.right + 1 && r(box).left >= p.left - 1, pageScroll: document.documentElement.scrollWidth > innerWidth + 1,
                    noneElsewhere: ['claude', 'codex', 'pi'].every(t => !document.querySelector('#settings-cli-path-' + t).closest('.sv-row').querySelector('.cli-refused-why')) }; })()`);
            const asked = await ev('window.__cliChecks.slice()');
            if (!asked.includes('agy') || asked.includes('codex') || asked.includes('pi')) problems.push(`${at}: opening Settings checks the default type (agy), not Codex or Pi: a check RUNS the CLI, and a real one in a suite trips #4354: ${JSON.stringify(asked)}`);
            if (s.count !== 1 || s.type !== 'agy' || s.inputId !== 'settings-cli-path-agy') problems.push(`${at}: one line, under Antigravity's path ${JSON.stringify(s)}`);
            if (!/^Not used: .*agy is inside .*Security Reviewer.*working folder/.test(s.text)) problems.push(`${at}: the line says why: ${s.text}`);
            if (!s.link) problems.push(`${at}: the agent's name is a link`);
            if (s.why !== 'Why?') problems.push(`${at}: a Why? fold (${s.why})`);
            if (!s.open || !s.shown || !s.inside || s.pageScroll) problems.push(`${at}: the paths are open and the line fits ${JSON.stringify(s)}`);
            if (!s.noneElsewhere) problems.push(`${at}: a CLI that is found or missing has no such line`);
            if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await ev(`document.querySelector('#settings-pane-agents .cli-refused-why').scrollIntoView({ block: 'center' }); true`); await sleep(200); // sleep-ok: a frame for the scroll before the shot
 fs.writeFileSync(`${process.env.SHOT_DIR}/settings-refused-${w}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Settings > Agents, a CLI found and not used:\n  ' + problems.join('\n  '));
    console.log('PASS Settings > Agents says why a found CLI is not used');
})().catch(e => { console.error(e); process.exit(1); });
