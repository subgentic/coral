// #8766: primary links in Inbox Tasks and Board history, both widths and themes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { setTheme, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const measurements = [], failures = [];
    const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(INBOX_WORLD);
            await ev(`(() => {
                const real = window.fetch;
                const sessions = [1, 2].map(id => ({session_id:'contrast-board-'+id,type:'group',display_name:'Review board '+id,title:'Release planning',message_count:3,last_timestamp:new Date().toISOString(),source_type:'claude'}));
                window.fetch = (u,o) => {
                    const p = new URL(String(u && u.url || u),location.origin).pathname;
                    if(p === '/api/sessions/history/counts')return Promise.resolve(Response.json({total:2,agent:0,group:2,by_agent_type:{}}));
                    if(p === '/api/sessions/history')return Promise.resolve(Response.json({sessions,total:2,page:1,page_size:50}));
                    return real(u,o);
                }; return true;
            })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            for (const folder of ['tasks', 'chats-group']) {
                await ev(`import((window.__coralStatic || '/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('${folder}')).then(()=>true)`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody .dt-primary').length === ${folder === 'tasks' ? 3 : 2}`, folder+' primary links');
                for (const theme of ['light', 'dark']) {
                    await setTheme(ev, theme);
                    const audit = await auditRegion(ev, ['#group-table-view tbody .dt-primary'], { samples: true });
                    assert.ok(audit.samples.length >= (folder === 'tasks' ? 3 : 2), 'every row has measured primary text');
                    measurements.push({ width, theme, folder, ...audit });
                    failures.push(...audit.samples.filter(s=>s.ratio<4.5).map(s=>({width,theme,folder,...s})));
                    if(dir){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`inbox-contrast-${folder}-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
                }
            }
        }
        console.log(JSON.stringify(measurements));
        if(dir)fs.writeFileSync(path.join(dir,'inbox-contrast-measurements.json'),JSON.stringify(measurements,null,2));
        assert.deepEqual(failures, [], 'every primary text sample must reach 4.5:1');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
