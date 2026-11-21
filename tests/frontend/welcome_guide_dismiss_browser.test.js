// #18945: reading Getting started does not dismiss it. Closing keeps it first in Needs you;
// explicit Dismiss removes it and records the named item in the real Activity folder.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, row = '#group-table-view tr[data-welcome-id="guide"]';
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; require('node:fs').mkdirSync(dir, {recursive:true}); require('node:fs').writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    const needs = () => ev(`window.switchNavTab('hub-inbox'); import(${S}+'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => { const values = {inbox_welcome:'on',inbox_welcome_done:'',inbox_welcome_setup:'off'};
                await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json','X-Coral-Auto-Save':'1'},body:JSON.stringify(values)});
                Object.assign(T.state.settings,values); T.state.liveSessions=[]; T.state.servers=[];
                const real=window.fetch; window.fetch=(u,o)=>new URL(String(u),location.href).pathname==='/api/board/projects' ? Promise.resolve(Response.json([])) : real(u,o); })()`);
            await needs(); await waitFor(`!!document.querySelector('${row}')`, width + ': guide row');
            const activityCount = () => ev(`fetch('/api/activity').then(r=>r.json()).then(d=>(d.actions||[]).filter(r=>r.title==='Read the Coral guide').length)`);
            const before = await activityCount();
            for (const close of width === 390 ? ['away', 'escape', 'back'] : ['away', 'escape']) {
                await ev(`document.querySelector('${row} .inbox-main-action, ${row} .dt-mail-open').click(); true`);
                await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden]) .artifact-viewer-body h1')`, width + ': guide opens');
                if (close === 'away') await ev(`document.getElementById('artifact-viewer').click(); true`);
                else if (close === 'back') await ev(`history.back(); true`);
                else { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' }); }
                await waitFor(`document.getElementById('artifact-viewer').hidden`, width + ': guide closes');
                assert.equal(await ev(`document.querySelector('#group-table-view tbody tr.dt-row')?.dataset.welcomeId`), 'guide', width + ': closing by ' + close + ' leaves the guide first');
                assert.equal(await ev(`String(T.state.settings.inbox_welcome_done).split(',').includes('guide')`), false, width + ': closing never completes the guide');
                assert.equal(await activityCount(), before, width + ': closing does not add a handled Activity item');
            }
            await shot(`guide-kept-${width}`);
            await ev(`[...document.querySelectorAll('${row} button')].find(b=>b.textContent==='Dismiss').click(); true`); // #20264: sole Dismiss is direct at both widths.
            await waitFor(`!document.querySelector('${row}')`, width + ': explicit Dismiss removes guide');
            await waitFor(`fetch('/api/activity').then(r=>r.json()).then(d=>(d.actions||[]).some(r=>r.title==='Read the Coral guide'))`, width + ': real Activity records dismissed guide');
            await waitFor(`fetch('/api/activity').then(r=>r.json()).then(d=>(d.actions||[]).filter(r=>r.title==='Read the Coral guide').length === ${before + 1})`, width + ': Dismiss adds one Activity entry');
            await ev(`import(${S}+'inbox_tab.js').then(m=>m.selectInboxTab('activity')).then(()=>true)`);
            await waitFor(`/Read the Coral guide/.test(document.getElementById('group-table-view').textContent)`, width + ': guide shown in Activity');
            await shot(`guide-activity-${width}`);
        }
    } finally { await guard.restore(); await client.close(); }
    console.log('welcome_guide_dismiss: closing keeps guide; Dismiss moves it to Activity');
})().catch(e=>{console.error(e);process.exit(1);});
