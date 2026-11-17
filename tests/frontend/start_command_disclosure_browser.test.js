// #19016: Restart settings and the shared custom command preview start collapsed at 1440/390; Copy works closed, expanding preserves the full command. Before/after screenshots use the same probe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); } };
    const check = async (root, label) => {
        await waitFor(`!!document.querySelector('${root} .lrc-copy')`, label + ': command arrived');
        const initial = await ev(`(()=>{const r=document.querySelector('${root} .launch-recap-command'), c=r.querySelector('.lrc-text'), b=r.querySelector('.lrc-more');return {closed:b?.getAttribute('aria-expanded')==='false'&&!c.getClientRects().length,command:c.textContent,copy:!!r.querySelector('.lrc-copy').getClientRects().length};})()`);
        if (!initial.closed || !initial.copy) problems.push(label + ': command is collapsed with Copy available: ' + JSON.stringify(initial));
        if (!root.startsWith('#command-fixture')) { const vis = await ev(`(() => { const l = document.querySelector('${root} .launch-recap-flags:not(.launch-recap-command)'); return !!l && l.getClientRects().length > 0 && !l.closest('.lrc-body') && /^Adds /.test(l.textContent); })()`); if (!vis) problems.push(label + ': the Adds flags line is visible outside the collapsed Start command panel (#19335)'); }
        await shot(label+'-closed');
        await ev(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.__copied=t;}}});document.querySelector('${root} .lrc-copy').click();true`);
        await waitFor(`window.__copied===${JSON.stringify(initial.command)}`, label+': Copy closed command');
        await ev(`document.querySelector('${root} .lrc-more').click();true`); await ev(framesJs(3));
        const expanded = await ev(`(()=>{const r=document.querySelector('${root} .launch-recap-command'),c=r.querySelector('.lrc-text');return r.querySelector('.lrc-more').getAttribute('aria-expanded')==='true'&&!!c.getClientRects().length&&c.textContent===${JSON.stringify(initial.command)};})()`);
        if (!expanded) problems.push(label+': expand reveals unchanged command');
        await shot(label+'-expanded');
        await ev(`document.querySelector('${root} .lrc-more').click();true`);
        if (await ev(`!!document.querySelector('${root} .lrc-text').getClientRects().length`)) problems.push(label+': collapse hides command again');
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const [w,h,mobile] of [[1440,900,false],[390,844,true]]) {
            await Emulation.setDeviceMetricsOverride({width:w,height:h,deviceScaleFactor:1,mobile}); await Emulation.setTouchEmulationEnabled({enabled:mobile});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev); await stubCliChecks(ev,[]);
            await ev(`(async()=>{const S=window.__coralStatic||'/static/';window.T={state:(await import(S+'state.js')).state,stage:(await import(S+'restart_flow.js')).restartStage};await(await import(S+'lazy_panels.js')).loadModals();T.state.currentSession={name:'frontend',display_name:'Frontend Dev',session_id:'command-restart',type:'live',agent_type:'codex',model:'gpt-6.1-sol',prompt:'Build clear interfaces.',permission_mode:'bypassPermissions'};window.restartSession();return true;})()`);
            await waitFor(`!!document.querySelector('#restart-acf .acf-permission-mode')`,'restart form');
            await ev(`T.stage('agent');true`); await check('#restart-flags', 'restart-'+w);
            await ev(`document.querySelector('#restart-modal [data-on-click="hideRestartModal"]')?.click();document.getElementById('restart-modal').style.display='none';true`);
            // custom_modes.js calls the same exported commandNode directly, without the permission notes.
            await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'permission_flags_line.js');const host=document.createElement('div');host.id='command-fixture';host.append(m.commandNode('codex --sandbox read-only --model gpt-6.1-sol'));document.body.append(host);return true;})()`);
            await check('#command-fixture','custom-command-'+w);
        }
        assert.deepEqual(problems,[]);
        console.log('PASS Start command disclosure: Restart and custom preview, 1440/390, Copy while closed, expand/collapse preserves command');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
