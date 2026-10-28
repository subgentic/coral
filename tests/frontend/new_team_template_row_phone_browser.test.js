// New team step 2 on a phone (#10532, the mobile tester's pass 33): the template select is on a row of its own, so its choice reads whole ("Default team (3 members)", not "Default team" cut at the edge, with
// Describe your team and More on the row below it. 390 px with touch. The dialog is the real one, with the template list and models stubbed (helpers/new_team.js). Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor); await settle(400);
        await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
        await t.click('button', N.next); await t.step(2); await settle(400);
        if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/new-team-step2-phone.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        const r = await ev(`(() => { const R = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width }; };
            const sel = document.getElementById('team-template-select'), o = sel.options[sel.selectedIndex], cs = getComputedStyle(sel), cv = document.createElement('canvas').getContext('2d'); cv.font = cs.font;
            return { sel: R(sel), describe: R(document.getElementById('team-describe')), more: R(document.getElementById('team-template-more')), text: o.text, need: cv.measureText(o.text).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 24 /* the arrow */ }; })()`);
        if (r.need > r.sel.w) problems.push(`the template choice "${r.text}" needs ${Math.round(r.need)} px and the select has ${Math.round(r.sel.w)}: it is cut at the edge`);
        if (r.describe.t < r.sel.b - 1 || r.more.t < r.sel.b - 1) problems.push(`Describe your team and More are on the row below the select (select bottom ${Math.round(r.sel.b)}, they start at ${Math.round(r.describe.t)} and ${Math.round(r.more.t)})`);
        if (r.more.r > 390 || r.describe.l < 0) problems.push('the two buttons are on the screen');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'New team step 2 on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the template select reads whole on a phone, with its two buttons on the row below');
})().catch(e => { console.error(e); process.exit(1); });
