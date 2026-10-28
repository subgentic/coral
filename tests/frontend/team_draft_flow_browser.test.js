// Describe your team goes straight to the draft (#10517, Beta recheck and the Desktop tester): (1) the dialog's empty-box error has its space reserved, so Generate and Try a sample do not move when it appears (a second
// click missed by 29 px); (2) Try a sample, like a generated draft, lands on the Members step at once with Review Team as the only next step, the draft replaces the template's members, the step says "Drafted: 3 members"
// above the list until something is edited, and the sample's names are not any template's. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility({ checkVisibilityCSS: true }); })()`;
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'draft-x'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-team-next').click(); true`);
        await waitFor(vis('#team-template-select'), 'the Members step', 8000);
        const before = await ev(`[...document.querySelectorAll('#team-agents-list [role=listitem], #team-agents-list > *')].map(r => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40))`);
        assert.ok(before.length > 0, 'the template has members to replace: ' + JSON.stringify(before));
        await ev(`document.getElementById('team-describe').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('team-wizard-modal')).display !== 'none'`, 'the dialog', 4000);
        // 1. the error does not move the buttons
        const pos = () => ev(`(() => { const t = document.getElementById('team-wizard-test-btn').getBoundingClientRect(), g = document.getElementById('team-wizard-generate-btn').getBoundingClientRect(); return [Math.round(t.top), Math.round(g.top)]; })()`);
        const still = await pos();
        await ev(`document.getElementById('team-wizard-generate-btn').click(); true`); await settle(250);
        assert.match(await ev(`document.getElementById('team-wizard-error').textContent`), /^Describe your team first/, 'the error shows');
        assert.deepEqual(await pos(), still, 'Generate and Try a sample have not moved: ' + JSON.stringify([still, await pos()]));
        // 2. Try a sample shows what it will add before it replaces the members (#10658), then goes to the drafted members
        await ev(`document.getElementById('team-wizard-test-btn').click(); true`); await settle(300);
        const preview = await ev(`(() => { const e = document.getElementById('team-wizard-error'); return { text: e.textContent.trim(), quiet: e.classList.contains('team-wizard-error-quiet'), open: getComputedStyle(document.getElementById('team-wizard-modal')).display !== 'none', btn: document.getElementById('team-wizard-test-btn').textContent.trim(), rows: document.querySelectorAll('#team-agents-list > *').length }; })()`);
        assert.ok(preview.open && !preview.quiet && /Orchestrator, Sample Builder, Sample Reviewer/.test(preview.text) && /replaces/i.test(preview.text), 'the first press says what the sample will add: ' + JSON.stringify(preview));
        assert.equal(preview.rows, before.length, 'and has replaced nothing yet: ' + JSON.stringify(preview));
        assert.deepEqual(await pos(), still, 'the buttons did not move for it');
        assert.equal(preview.btn, 'Replace members', 'the button says what the next press does: ' + JSON.stringify(preview));
        await ev(`document.getElementById('team-wizard-test-btn').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('team-wizard-modal')).display === 'none'`, 'the dialog closes by itself', 6000);
        await waitFor(vis('#team-agents-list'), 'the members', 4000);
        const names = await ev(`[...document.querySelectorAll('#team-agents-list [role=listitem], #team-agents-list > *')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.equal(names.length, 3, 'three members: ' + JSON.stringify(names));
        assert.ok(/^Orchestrator/.test(names[0]) && names.slice(1).every(n => /^Sample /.test(n)), 'the sample keeps the one Orchestrator a team needs, and its other members have names no template uses: ' + JSON.stringify(names));
        assert.ok(!before.slice(1).some(b => names.some(n => n.startsWith(b.slice(0, 12)))), 'none of the template\'s other members is left: ' + JSON.stringify({ before, names }));
        const note = await ev(`(() => { const n = document.getElementById('team-drafted-note'); return n && !n.hidden && n.checkVisibility({ checkVisibilityCSS: true }) ? n.textContent.trim() : null; })()`);
        assert.equal(note, 'Drafted: 3 members. Change anything below before you launch.', 'the step says it is a draft: ' + note);
        // the person's team name and folder are kept (the sample renamed 'shop' to 'sample-team' and cleared the folder, #10658)
        assert.equal(await ev(`document.getElementById('team-board-name').value`), 'draft-x', 'the team name the person typed is kept');
        assert.equal(await ev(`document.getElementById('launch-team-dir').value`), '/work/x', 'and so is the folder');
        // the sample is a team that can go on (#10658): Next from the Members step is not blocked for want of an Orchestrator
        await ev(`document.getElementById('launch-team-next').click(); true`); await settle(500);
        const next = await ev(`({ members: getComputedStyle(document.getElementById('team-panel-members')).display, recap: (document.getElementById('team-recap') || {}).textContent || '' })`);
        assert.ok(next.members === 'none' && !/Orchestrator/.test(next.recap), 'Next goes on from the sample: ' + JSON.stringify(next));
        await ev(`document.getElementById('launch-team-back') ? document.getElementById('launch-team-back').click() : null; true`); await settle(400);
        // until something is edited
        await ev(`document.querySelector('#team-agents-list [data-on-click="team-agent-remove"], #team-agents-list .team-agent-remove') ? document.querySelector('#team-agents-list [data-on-click="team-agent-remove"], #team-agents-list .team-agent-remove').click() : document.querySelector('#team-panel-members button[data-on-click="m-add-team-agent"], #team-panel-members #team-add-member').click(); true`);
        await settle(300);
        assert.equal(await ev(`(() => { const n = document.getElementById('team-drafted-note'); return !n || n.hidden || !n.checkVisibility({ checkVisibilityCSS: true }); })()`), true, 'the note goes once the draft is edited');
        console.log('PASS Describe your team goes straight to the draft');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
