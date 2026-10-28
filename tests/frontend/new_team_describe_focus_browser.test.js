// Describe your team by keyboard (#10652, the New project dialog's keyboard and screen-reader pass): the box opens with the keyboard in its text box; Escape or Cancel closes it and the keyboard goes back to the
// Describe your team button it came from (it fell to the page, so the next Tab started at the top of the window). 1280 and 390 px; the real dialog on the isolated dev server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const problems = [];
    const key = async (k, code, text) => { const b = { key: k, code: k, windowsVirtualKeyCode: code }; await client.Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(text ? { text } : {}) }); await client.Input.dispatchKeyEvent({ type: 'keyUp', ...b }); await settle(300); };
    const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : a.tagName.toLowerCase() + (a.id ? '#' + a.id : ''); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            await openNewTeam(ev, waitFor); await settle(400);
            await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
            await t.click('button', N.next); await t.step(2); await settle(400);
            for (const how of ['Escape', 'Cancel']) {
                await ev(`document.getElementById('team-describe').focus(); true`); await key('Enter', 13, '\r');
                await waitFor(`getComputedStyle(document.getElementById('team-wizard-modal')).display !== 'none'`, `${w}: the box opens`, 4000);
                const open = await where();
                if (open !== 'textarea#team-wizard-directive') problems.push(`${w}: the box opens with the keyboard in its text box (it is on ${open})`);
                if (how === 'Escape') await key('Escape', 27); else await ev(`[...document.querySelectorAll('#team-wizard-modal button')].find(b => /^Cancel$/.test(b.textContent.trim())).focus(); true`).then(() => key('Enter', 13, '\r'));
                await settle(300);
                const back = await where();
                if (back !== 'button#team-describe') problems.push(`${w}: ${how} puts the keyboard back on Describe your team (it is on ${back})`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Describe your team by keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS Describe your team: Escape and Cancel give the keyboard back to its button');
})().catch(e => { console.error(e); process.exit(1); });
