// How much text the Launch / New Agent dialog shows (#6316, the usability pass as for Settings, #5985): the words a person can see in each state, counted (text nodes whose whole path is shown; a select's
// options are not text), against a budget: a paragraph that creeps back fails here. The states: the chooser, the New Agent step, and New Agent with More options open; at 1280 and 390 px. Also: the chooser is as
// high as its content (it had the tabbed dialogs' 30rem floor, half of it empty) and More options does not repeat a section's name as a heading under the tab that names it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const BUDGET = { chooser: 52, /* the title "New agent or project" (#7064) and the four description lines the type cards say again (#9253, the Operator): 10 + 9 + 10 + 11 words */ folder: 30, persona: 81, agent: 59 }; // the three New Agent steps as the design words them (#7391): measured at 1280 px (the phone shows fewer). Step 1's 30 includes the 10-word "Next: the persona, then model and permissions. All have defaults." line (UI/UX cut it from 20), the step header, the screen-reader reason for Next and the Recent: label

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    // (the "not installed" marks, the "Updating the list..." line under Model and the CLI check's "Checking claude CLI..." or missing-CLI note are the machine's and a moment's words, not the dialog's: left out)
    const words = () => ev(`(() => { let n = 0; const shown = e => { for (let p = e; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || p.hidden || (p.parentElement && p.parentElement.matches('details:not([open])') && p.tagName !== 'SUMMARY')) return false; } return true; };
        const w = document.createTreeWalker(document.getElementById('launch-modal'), NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) { const e = t.parentElement; if (!e || e.closest('script, style, .material-icons, select, option, .launch-agent-missing, .acf-model-note, .launch-cli-slot') || !shown(e)) continue; n += t.nodeValue.trim().split(/\\s+/).filter(Boolean).length; }
        return n; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'launch_server.js'); localStorage.removeItem(m.recentDirsKey('local')); return true; })()`); // an earlier suite's folders would add the Recent: row to the count
            await ev(`(async () => { await window.showLaunchModal(); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-chooser')).display !== 'none'`, `${tag}: the chooser`, 8000);
            let n = await words();
            assert.ok(n <= BUDGET.chooser, `${tag}: the chooser shows ${n} words, budget ${BUDGET.chooser}`);
            const box = await ev(`(() => { const c = document.querySelector('#launch-modal .modal-content').getBoundingClientRect(), s = document.getElementById('launch-step-chooser').scrollHeight; return { h: Math.round(c.height), content: s }; })()`);
            assert.ok(box.h <= box.content + 60, `${tag}: the chooser is as high as its content (${box.h} px for ${box.content} px of content), not a 30rem floor`);
            await ev(`document.querySelector('#launch-step-chooser [data-arg="agent"]').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none'`, `${tag}: the New Agent step`, 8000);
            n = await words();
            assert.ok(n <= BUDGET.folder, `${tag}: New Agent step 1 (the folder) shows ${n} words, budget ${BUDGET.folder}`);
            await ev(`document.getElementById('launch-dir').value = '/tmp'; document.getElementById('launch-agent-next').click(); true`);
            await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'persona'`, `${tag}: step 2`, 8000);
            n = await words();
            assert.ok(n <= BUDGET.persona, `${tag}: New Agent step 2 (the persona) shows ${n} words, budget ${BUDGET.persona}`);
            await ev(`document.getElementById('launch-agent-next').click(); true`);
            await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent'`, `${tag}: step 3`, 8000);
            await waitFor(`document.getElementById('launch-agent-acf').classList.contains('has-agent-pick')`, `${tag}: the agent choice is built`, 8000);
            n = await words();
            assert.ok(n <= BUDGET.agent, `${tag}: New Agent step 3 (the agent) shows ${n} words, budget ${BUDGET.agent}`);
            const title = await ev(`getComputedStyle(document.querySelector('#launch-agent-acf .settings-pane:not([hidden]) .settings-pane-title')).display`);
            assert.notEqual(title, 'none', `${tag}: the open section is named by a heading beside its tabs (the design's)`);
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('PASS launch dialog text: within budget, the chooser fits its content, no repeated section heading');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
