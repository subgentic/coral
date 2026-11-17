// #17484: explicit files in questions link; Model reaches the Orchestrator on template and Blank paths.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, M, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const t = T(ev, waitFor), mem = M(ev, waitFor);
    const pick = (id, value) => ev(`(()=>{const s=document.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    const models = () => ev(`(async()=>{const {getAgentConfig}=await import((window.__coralStatic||'/static/')+'agent_config_form.js');return [...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r=>({name:r.querySelector('.team-agent-role-name').textContent,model:getAgentConfig(r.dataset.acfId).model||''}));})()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install();
            await require('./helpers/wait').coralReady(ev); await installNT(ev); await stubModels(ev);
            const hex='a'.repeat(64);
            await ev(`(async()=>{const {openAskDialog}=await import((window.__coralStatic||'/static/')+'operator_ask_dialog.js');openAskDialog({id:41,board:'model-test',asker:'Orchestrator',kind:'ask',text:'Please review the plan: coral://artifacts/${hex}',at:new Date().toISOString()},()=>{});return true;})()`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open] a[data-artifact="${hex}"]')`,'explicit plan reference becomes a link');
            assert.equal(await ev(`new URL(document.querySelector('dialog.inbox-ask-dialog a[data-artifact]').href).pathname`),'/api/artifacts/'+hex);
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn').click();true`);
            await openNewTeam(ev,waitFor); await t.to(2);
            await waitFor(`document.querySelector('#team-set-all-model option[value="claude-small"]')`,'model choices loaded');
            await pick('team-set-all-model','claude-small');
            assert.ok((await models()).every(r=>r.model==='claude-small'),width+': template members including Orchestrator take Model: '+JSON.stringify(await models()));
            // Selecting the same provider preserves the model (#15121 / M10).
            await pick('team-set-all','claude');
            assert.ok((await models()).every(r=>r.model==='claude-small'),width+': same provider preserves Model');
            // An explicit edit keeps its own model when Everyone changes again.
            await ev(`document.querySelector('#team-agents-list .team-agent-edit-btn').click();true`);
            await waitFor(`!!window.__nt.dlg(${N.member})`,'edit Orchestrator'); await mem.section('Agent');
            assert.ok(await t.pick(/^Model$/i,/claude Big/i,N.member),'explicit Orchestrator model'); await mem.save();
            await pick('team-set-all-model','');
            const own=await models(); assert.equal(own[0].model,'claude-big','manual Orchestrator model stays'); assert.ok(own.slice(1).every(r=>!r.model),'following workers take default');
            await t.pick(N.template,/^Blank/); await t.click('button',N.addOrch);
            await waitFor(`document.querySelector('#team-set-all-model').getClientRects().length && document.querySelector('#team-set-all-model option[value="claude-small"]')`,'Blank Orchestrator has Everyone Model');
            await pick('team-set-all-model','claude-small');
            assert.deepEqual(await models(),[{name:'Orchestrator',model:'claude-small'}],'Blank Orchestrator takes Model');
            await t.click('button',N.cancel);
        }
        console.log('PASS explicit ask artifact link, template/Blank Orchestrator Model, same-provider preservation and manual override at 1280/390');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
