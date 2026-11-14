// The New team wizard warns, in one quiet line, when another live agent or team already works in the folder the person chose (#17196 item 5, walk 51):
// "<agent or team> also works in this folder; both can change the same files." A warning, never a block: Next still goes on. A different folder, or no live agent there, shows no line.
// 1280 and 390 px, driven over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('fs').mkdirSync(d, { recursive: true }); require('fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`T.state.liveSessions = [{ session_id: 'a1', name: 'first-agent', display_name: 'first-agent', working_directory: '/work/shop', agent_type: 'claude' }, { session_id: 'b1', name: 'w1', display_name: 'w1', board_project: 'alpha', working_directory: '/work/team-dir' }, { session_id: 'b2', name: 'w2', display_name: 'w2', board_project: 'alpha', working_directory: '/work/team-dir/' }]; true`);
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
            const fill = v => ev(`(() => { const e = document.getElementById('launch-team-dir'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            const line = () => ev(`(() => { const l = document.getElementById('launch-team-dir-shared'); return l ? { shown: !l.hidden && l.getClientRects().length > 0, text: l.textContent } : null; })()`);
            await fill('/work/shop');
            let l = await line();
            assert.ok(l && l.shown, `${tag}: a folder a live agent works in gets the line: ${JSON.stringify(l)}`);
            assert.equal(l.text, 'first-agent also works in this folder; both can change the same files.', `${tag}: names the agent`);
            await shot(`team-shared-folder-${w}`);
            await fill('/work/team-dir');
            l = await line();
            assert.equal(l && l.text, 'alpha also works in this folder; both can change the same files.', `${tag}: names the team once, not each agent: ${JSON.stringify(l)}`);
            await fill('/work/elsewhere');
            l = await line();
            assert.ok(l && !l.shown, `${tag}: a folder nobody works in has no line: ${JSON.stringify(l)}`);
            console.log(`PASS ${tag}`);
            await ev(`window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
