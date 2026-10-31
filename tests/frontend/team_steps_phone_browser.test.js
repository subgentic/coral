// New team on a phone (#11401 b, from the Mobile Beta Tester's walk): the step line under the title names the team and its folder, and a long folder path wrapped over four lines; it is the end of the path now,
// and a tap shows all of it. Step 3's section picker says what it is, and the two lines Coral adds there are the size of the help text around them. Isolated dev server, 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const LONG = '/private/tmp/claude-501/-Users-someone-Software-coral-coral-go/8e42ea4f-3af8-38c9-938f-4a4bf9e53fae/scratchpad/d452/home/Coral/first-team';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
        await waitFor(`(() => { const e = document.getElementById('launch-step-team'); return !!e && getComputedStyle(e).display !== 'none'; })()`, 'the team step', 8000);
        await ev(`(async () => { document.getElementById('team-board-name').value = 'demo-team'; document.getElementById('launch-team-dir').value = ${JSON.stringify(LONG)}; const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('start'); return true; })()`);
        await waitFor(`!!document.querySelector('#team-panel-start .team-start-lead, #launch-step-team .team-start-lead')`, 'step 3 drawn', 8000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the step draws
        const q = () => ev(`(() => {
            const sub = document.getElementById('team-stage-sub'), cs = getComputedStyle(sub), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
            const path = sub.querySelector('button.team-sub-path'), lead = document.querySelector('#launch-step-team .team-start-lead'), state = document.getElementById('team-goal-state');
            const help = [...document.querySelectorAll('#launch-step-team .sv-help, #launch-step-team .settings-hint, #launch-step-team .sv-row-help')].find(e => e.offsetParent && e.textContent.includes('first task')) || null;
            const pick = document.querySelector('#launch-step-team .settings-group-pick'), lab = pick && pick.querySelector('.settings-group-pick-label');
            const fs = e => e ? parseFloat(getComputedStyle(e).fontSize) : null;
            return { lines: Math.round(sub.getBoundingClientRect().height / lh), text: sub.textContent, pathText: path ? path.textContent : null, expanded: path ? path.getAttribute('aria-expanded') : null, label: path ? path.getAttribute('aria-label') : null,
                pickLabel: lab && getComputedStyle(lab).display !== 'none' ? lab.textContent.trim() : null, leadPx: fs(lead), statePx: fs(state), helpPx: fs(help) };
        })()`);
        const a = await q();
        if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR + '/team-step3-390.png', Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        assert.ok(a.lines <= 2, `the step line is at most two lines (was 4): ${a.lines}: ${a.text}`);
        assert.ok(a.pathText && a.pathText.length < 40 && a.pathText.endsWith('first-team') && a.pathText.startsWith('…'), `the folder is the end of its path: ${JSON.stringify(a.pathText)}`);
        assert.equal(a.expanded, 'false', 'the shortened path is a button that says it is closed');
        assert.ok(a.label && a.label.includes(LONG), `its name has the whole path: ${a.label}`);
        assert.equal(a.pickLabel, 'Jump to a section', `step 3's picker says what it is: ${a.pickLabel}`);
        assert.ok(a.helpPx && a.leadPx <= a.helpPx + 3 && a.statePx <= a.helpPx + 3, `the lines Coral adds are the help text's size (${a.helpPx}px): lead ${a.leadPx}, goal state ${a.statePx}`);
        await ev(`document.querySelector('#team-stage-sub button.team-sub-path').click(); true`);
        const b = await q();
        assert.equal(b.expanded, 'true', 'a tap opens it'); assert.equal(b.pathText, LONG, 'all of the path shows');
        // a computer: the same line, one tap to the whole path (the picker is a phone's, the nav is on the left there)
        await ev(`window.hideLaunchModal(); true`);
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
        await waitFor(`(() => { const e = document.getElementById('launch-step-team'); return !!e && getComputedStyle(e).display !== 'none'; })()`, 'the team step at 1280', 8000);
        await ev(`(async () => { document.getElementById('team-board-name').value = 'demo-team'; document.getElementById('launch-team-dir').value = ${JSON.stringify(LONG)}; const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('start'); return true; })()`);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the step draws
        const c = await q();
        assert.ok(c.lines <= 2 && c.pathText && c.pathText.endsWith('first-team') && c.pathText.length < 40, `1280: the step line is short: ${c.lines} lines, ${JSON.stringify(c.pathText)}`);
        await ev(`document.querySelector('#team-stage-sub button.team-sub-path').click(); true`);
        assert.equal((await q()).pathText, LONG, '1280: a click shows all of the path');
        await ev(`window.hideLaunchModal(); true`);
        console.log('PASS new team on a phone: the step line, the picker label, the text sizes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
