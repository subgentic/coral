// The New team dialog opens with the default team in Members (#9877, the Operator's 06:10 shot): Orchestrator, Lead Developer, QA Engineer, in that order, the roles exact so the team has its Orchestrator and
// the "Add an Orchestrator" notice is not there on open. Each is removable, and a template still replaces them. 1280 px, isolated dev server, controls by role and name (helpers/new_team.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNT, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    const roles = () => ev(`window.__nt.roles(window.__nt.dlg(${require('./helpers/new_team').N.team}))`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor);
        await t.to(2, {}); // the Members step, no template picked
        assert.deepEqual(await roles(), ['Orchestrator', 'Lead Developer', 'QA Engineer'], 'the dialog opens with the default team in Members, roles exact');
        const chosen = () => ev(`(() => { const s = document.getElementById('team-template-select'); return s.options[s.selectedIndex].textContent.trim(); })()`);
        assert.match(await chosen(), /^Default team/, 'the template choice says the default team is in Members, not "Blank team" (#9906)');
        assert.equal(await ev(`document.getElementById('team-orchestrator-line').hidden`), true, 'the "Add an Orchestrator" notice is not there: the team has one');
        assert.equal(await ev(`getComputedStyle(document.querySelector('#team-agents-list').parentElement.querySelector('.empty-state')).display`), 'none', 'and "No members yet" is not said');
        assert.equal(await ev(`document.querySelectorAll('#team-agents-list > *').length`), 3, 'three member rows');
        assert.equal(await ev(`[...document.querySelectorAll('#team-agents-list > *')].every(r => r.querySelector('.team-agent-edit-btn'))`), true, 'each member has its Edit button (Remove is in the Edit member dialog, #10836)');
        await shot('new-team-default-members');
        // the Lead Developer and the QA Engineer are removable; the Orchestrator has no Remove (the team's gate: new_team_steps), it is renamed or the team starts without by Back
        const editHasRemove = async n => { await ev(`document.querySelectorAll('#team-agents-list > *')[${n}].querySelector('.team-agent-edit-btn').click(); true`); await settle(400); return ev(`document.getElementById('launch-agent-remove').getClientRects().length > 0`); };
        const cancelEdit = async () => { await ev(`document.getElementById('launch-agent-cancel').click(); true`); await settle(300); };
        assert.equal(await editHasRemove(0), false, 'the Orchestrator has no Remove, as before'); await cancelEdit();
        assert.equal(await editHasRemove(1), true, 'the Lead Developer can be removed (Remove from team, in the Edit member dialog)');
        await ev(`document.getElementById('launch-agent-remove').click(); true`); await settle(300);
        assert.deepEqual(await roles(), ['Orchestrator', 'QA Engineer'], 'Remove takes the member out');
        assert.match(await chosen(), /^Default team \(2 members\)$/, 'the choice says how many members there are now (#10052)');
        // Blank team clears them and says so; the Default team choice brings the three back
        await t.pick(require('./helpers/new_team').N.template, /^Blank/); await settle(300);
        assert.deepEqual(await roles(), [], 'Blank team clears the members');
        assert.match(await chosen(), /^Blank team/, 'and the choice says Blank team');
        await t.pick(require('./helpers/new_team').N.template, /^Default team/); await settle(300);
        assert.deepEqual(await roles(), ['Orchestrator', 'Lead Developer', 'QA Engineer'], 'the Default team choice puts the three back');
        assert.match(await chosen(), /^Default team \(3 members\)$/, 'and three again');
        // a template still replaces them
        await t.pick(require('./helpers/new_team').N.template, /Consumer Research/);
        await settle(300);
        const replaced = await roles();
        assert.ok(replaced.length >= 5 && replaced[0] === 'Orchestrator' && !replaced.includes('QA Engineer'), 'a template replaces the default members: ' + JSON.stringify(replaced));
        console.log('PASS the New team dialog opens with Orchestrator, Lead Developer, QA Engineer; two removable; a template replaces them');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
