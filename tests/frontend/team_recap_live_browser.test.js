// The line above the New project buttons is a polite live region (#team-recap): it says why Next is off, or the recap "<team>: 3 members, <folder>". It was rewritten every time the step, a field or a CLI check was synced, with the
// same words each time, and a screen reader says a rewritten region again: one tap on Next with no name said "Team name is required" seven times (#10693, the first-run keyboard and screen-reader pass). Now an unchanged line is left
// alone: a blocked Next, a step shown again and typing that changes nothing write it at most once. At 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.showLaunchModal(); true`);
            await waitFor(`document.querySelector('#launch-modal .modal-content') && document.querySelector('#launch-modal .modal-content').getClientRects().length > 0`, `${w}: the launch dialog`, 8000);
            await ev(`window._selectLaunchType('team'); true`);
            await waitFor(`document.getElementById('launch-step-team').dataset.stage === 'team'`, `${w}: step 1`, 8000);
            const watch = () => ev(`window.__recapWrites = 0; window.__recapObs && window.__recapObs.disconnect(); window.__recapObs = new MutationObserver(ms => { for (const m of ms) if (m.addedNodes.length) window.__recapWrites++; }); window.__recapObs.observe(document.getElementById('team-recap'), { childList: true }); true`);
            const writes = async () => { await new Promise(r => setTimeout(r, 300)); return ev(`window.__recapWrites`); }; // sleep-ok: the observer's records are delivered after the writes
            // (1) Next with no name and no folder: the reason is written once, not on every sync
            await watch(); await ev(`document.getElementById('launch-team-next').click(); true`);
            const blocked = await writes();
            if (blocked > 1) problems.push(`${w}: one tap on Next with no name wrote the live line ${blocked} times (a screen reader says it ${blocked} times)`);
            // (2) the same words again: the step shown again, and an input that changes nothing
            await watch();
            await ev(`for (let i = 0; i < 3; i++) { document.dispatchEvent(new Event('team-step-shown', { bubbles: true })); document.getElementById('team-board-name').dispatchEvent(new Event('input', { bubbles: true })); } true`);
            const same = await writes();
            if (same !== 0) problems.push(`${w}: the same line written again ${same} times when nothing changed`);
            // (3) a real change still writes it: a name and a folder, then step 2's recap names the team
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'first-run'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/tmp/first-run'; d.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('launch-team-next').click(); } true`);
            await waitFor(`document.getElementById('launch-step-team').dataset.stage === 'members'`, `${w}: step 2`, 8000);
            await waitFor(`/first-run: \\d+ members?, \\/tmp\\/first-run/.test(document.getElementById('team-recap').textContent)`, `${w}: the recap names the team and its folder`, 5000);
            await watch();
            await ev(`document.dispatchEvent(new Event('team-step-shown', { bubbles: true })); true`);
            if ((await writes()) !== 0) problems.push(`${w}: step 2's recap is written again when nothing changed`);
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'second-run'; n.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            await waitFor(`/second-run: /.test(document.getElementById('team-recap').textContent)`, `${w}: a changed name changes the recap`, 5000);
            await ev(`window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the New project live line:\n  ' + problems.join('\n  '));
    console.log('PASS the New project line is written when it changes, not every sync');
})().catch(e => { console.error(e); process.exit(1); });
