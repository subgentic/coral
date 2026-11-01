// Rules that only a dialog or a page of its own needs are not in the start's stylesheet (#11403, start weight): the provider cards of New agent and the SSH setup page. Each arrives with the module that draws it (its sheet is
// loaded before the first draw), so the start does not carry rules nobody sees until then.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { Fetch } = client;
    const S = `(window.__coralStatic || '/static/')`;
    const hasRule = (needle, sheetPart) => ev(`(() => { for (const ss of document.styleSheets) { if (${JSON.stringify(sheetPart)} && !String(ss.href || '').includes(${JSON.stringify(sheetPart)})) continue; let rules; try { rules = ss.cssRules; } catch { continue; } for (const r of rules) { if ((r.selectorText || '').includes(${JSON.stringify(needle)})) return true; } } return false; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        for (const [needle, sheet, mod] of [['#launch-agent-pick.provider-cards', 'provider_cards.css', 'launch_provider_cards.js'], ['.ssh-setup', 'ssh_setup.css', 'server_ssh_setup.js']]) {
            assert.equal(await hasRule(needle, ''), false, `${needle} is not in a stylesheet at start`);
            await ev(`import(${S} + ${JSON.stringify(mod)}).then(() => true)`);
            assert.equal(await hasRule(needle, sheet), true, `${needle} is in ${sheet} once ${mod} has loaded`);
        }
        console.log('PASS the provider cards and SSH setup rules load with their modules');
        // The picture rules (#11651, #11653) are in no start sheet, and each module that draws a picture has its rules before its first draw: the sheet is held for 800 ms and the module's import (what the first draw waits for) still comes back with the rules in place.
        await Fetch.enable({ patterns: [{ urlPattern: '*/css/pictures.css', requestStage: 'Request' }] });
        safePaused(client, async e => { await new Promise(r => setTimeout(r, 800)); return Fetch.continueRequest({ requestId: e.requestId }); }); // sleep-ok: the slow sheet is the thing under test
        for (const [needle, mod] of [['.ac-thumbs', 'artifact_comment_images.js'], ['.ac-pics', 'artifact_comments.js'], ['.goal-pics', 'goal_view.js'], ['.goals-pics', 'goals_view.js']]) assert.equal(await hasRule(needle, ''), false, `${needle} is not in a stylesheet at start`);
        for (const [needle, mod] of [['.ac-thumbs', 'artifact_comment_images.js'], ['.ac-pics', 'artifact_comments.js'], ['.goal-pics', 'goal_view.js'], ['.goals-pics', 'goals_view.js']]) {
            await ev(`import(${S} + ${JSON.stringify(mod)}).then(() => true)`);
            assert.equal(await hasRule(needle, 'pictures.css'), true, `${needle} is in pictures.css as soon as ${mod} has loaded, even when the sheet is slow`);
        }
        console.log('PASS the picture rules are in place when their modules have loaded, with a slow sheet');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
