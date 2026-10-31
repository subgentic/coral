// Rules that only a dialog or a page of its own needs are not in the start's stylesheet (#11403, start weight): the provider cards of New agent and the SSH setup page. Each arrives with the module that draws it (its sheet is
// loaded before the first draw), so the start does not carry rules nobody sees until then.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
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
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
