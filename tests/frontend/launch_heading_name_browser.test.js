// The New agent, New team and Launch Terminal headings are named for the title alone (Beta #10372 finding 5, #10374): the back arrow sat inside the heading, so a screen reader read the heading as "Back to the choices New team"
// each time it read the title. The arrow is now a button beside the heading, still named "Back to the choices", and the dialog is still named by its title. Read from the accessibility tree at 1280 px. Drives Chrome over
// CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        for (const [type, heading, title, back] of [['team', '#launch-team-title', 'New project', '#launch-step-team .launch-back-btn'], ['agent', '#launch-agent-title', 'New agent', '#launch-step-agent .launch-back-btn'], ['terminal', '#launch-step-terminal h3', 'Launch Terminal', '#launch-step-terminal .launch-back-btn']]) {
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType(${JSON.stringify(type)}); return true; })()`);
            await waitFor(`(() => { const e = document.querySelector(${JSON.stringify(heading)}); return !!e && e.getClientRects().length > 0; })()`, `${type}: the heading`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the step draws
            const h = await axName(client, heading);
            check(h && h.role === 'heading' && h.name.trim() === title, `${type}: the heading's name is "${title}" in the tree (it is ${JSON.stringify(h)})`);
            const b = await axName(client, back);
            check(b && b.role === 'button' && /^Back/.test(b.name), `${type}: the back arrow is a button named Back, beside the heading (${JSON.stringify(b)})`);
            check(await ev(`(() => { const e = document.querySelector(${JSON.stringify(heading)}); return !e.querySelector('button'); })()`), `${type}: no button inside the heading`);
            await ev(`window.hideLaunchModal(); true`); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the dialog closes
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the launch headings in the accessibility tree:\n  ' + problems.join('\n  '));
    console.log('PASS the launch headings are named for the title alone');
})().catch(e => { console.error(e); process.exit(1); });
