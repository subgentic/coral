// #20110: Settings must expose the supported OpenCode provider, its path and account state.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`(() => {const real=window.fetch; window.__ocSigned=false; window.__ocChecks=[];
                window.fetch=(u,o)=>{const p=new URL(String(u),location.href);if(p.pathname==='/api/system/cli-check'){window.__ocChecks.push(p.search);return Promise.resolve(new Response(JSON.stringify({found:true,status:'available',signed_in:window.__ocSigned}),{headers:{'Content-Type':'application/json'}}));}return real(u,o);};})()`);
            await ev(`window.showSettingsModal('providers')`);
            await waitFor(`document.querySelector('#settings-provider-claude')?.dataset.state==='installed'`, 'provider checks complete');
            assert.equal(await ev(`!!document.getElementById('settings-provider-opencode')`), true, 'OpenCode has a Settings provider card');
            await waitFor(`document.querySelector('#settings-provider-opencode')?.dataset.state==='installed'`, 'OpenCode installation status');
            assert.equal(await ev(`document.querySelector('#settings-agent-type option[value=opencode]')?.textContent`), 'OpenCode', 'OpenCode is a default agent choice');
            assert.equal(await ev(`!!document.getElementById('settings-default-thinking-opencode')`), false, 'no unsupported OpenCode thinking control');
            assert.equal(await ev(`!!document.getElementById('settings-default-model-opencode')`), false, 'OpenCode keeps its own default model');
            assert.match(await ev(`document.getElementById('settings-providers-no-default').textContent`), /OpenCode.*configuration/, 'own model configuration explained');
            const payload = await ev(`(async()=>{document.getElementById('settings-provider-advanced-opencode').open=true;const i=document.getElementById('settings-cli-path-opencode');i.value='/tools/opencode';i.dispatchEvent(new Event('input',{bubbles:true}));return (await import((window.__coralStatic||'/static/')+'settings_form.js')).readSettingsForm(true).payload;})()`);
            assert.equal(payload.cli_path_opencode,'/tools/opencode','OpenCode CLI path reaches the Settings payload');
            assert.equal(await ev(`import((window.__coralStatic||'/static/')+'prerequisites.js').then(m=>!!m.cliPathButton('opencode'))`), true, 'missing CLI can open its path in Settings');
            await ev(`document.getElementById('verify-all-btn').click()`);
            await waitFor(`window.__ocChecks.some(q=>q.includes('type=opencode')&&q.includes('binary='))`, 'Verify All includes OpenCode');
            assert.equal(await ev(`window.__ocChecks.some(q=>q.includes('type=opencode')&&q.includes('binary='))`),true,'Verify All checks the OpenCode path');
            await ev(`window.hideSettingsModal(true);window.showSettingsModal('security')`);
            await ev(`document.getElementById('settings-accounts-check').click()`);
            await waitFor(`document.getElementById('settings-opencode-account-status')?.textContent.startsWith('Not signed in')`, 'OpenCode signed-out state');
            assert.equal(await ev(`document.querySelector('button[aria-label="Sign in to OpenCode"]').hidden`),false,'local OpenCode sign-in action is available');
            await ev(`window.__ocSigned=true;document.getElementById('settings-accounts-check').click()`);
            await waitFor(`document.getElementById('settings-opencode-account-status')?.textContent.startsWith('Signed in')`, 'OpenCode signed-in state');
            assert.equal(await ev(`document.querySelector('button[aria-label="Sign in to OpenCode"]').hidden`),true,'signed-in state hides Sign in');
            await ev(`window.hideSettingsModal(true)`);
        }
        console.log('PASS OpenCode Settings card, default agent choice, CLI path payload/verification and sign-in state at desktop and phone widths');
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
