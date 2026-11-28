// #13256 (the operator, through coral-hub: 'the coral hub inbox has a different layout than the coral local'): the Hub-served Inbox's sidebar used its own list: Artifacts under NEEDS ATTENTION, no FILES or HISTORY group,
// 'Saved for later' for Saved. It now uses local Coral's groups, order and words: one group, Your work (Needs you, Activity, Saved, Goals, Artifacts; #21325; Tasks out for now, #22109, was NEEDS ATTENTION, FILES and HISTORY) on the Hub as well as a computer (#20394).
// Local first (the plain dev server), then the stubbed Hub of helpers/hub_world.js (native boot). 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const GROUP_TITLES = ['Your work'];
    // the sidebar's first groups as [title, name, name, title, name ...], up to the first group that is not one of the three (the chat folders and boards follow)
    const sidebar = () => ev(`(() => { const nav = [...document.querySelectorAll('nav.view-list-nav')].find(n => [...n.querySelectorAll('.view-list-name')].some(e => e.textContent === 'Needs you')); if (!nav) return null;
        const out = []; for (const e of nav.querySelectorAll('.view-list-title, .view-list-name')) { if (e.classList.contains('view-list-title') && !${JSON.stringify(GROUP_TITLES)}.includes(e.textContent.trim())) break; out.push(e.textContent.trim()); } return out; })()`);
    const open = async () => {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 844, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(framesJs(8));
        await waitFor(`[...document.querySelectorAll('nav.view-list-nav .view-list-name')].some(e => e.textContent === 'Needs you')`, 'the Inbox sidebar', 10000);
    };
    try {
        await Page.enable();
        console.log('1. Local: Your work (Needs you, Activity, Saved, Goals, Artifacts; Tasks is out for now, #22109)');
        await open();
        const local = await sidebar();
        assert.deepEqual(local, ['Your work', 'Needs you', 'Activity', 'Saved', 'Goals', 'Artifacts'], JSON.stringify(local));
        await shot('hub-inbox-sidebar-local');
        console.log('   ✓');

        console.log('2. The Hub-served Inbox: the same groups, order and words; Your work includes the owner Activity record');
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native' });
        await open();
        const hub = await sidebar();
        await shot('hub-inbox-sidebar-hub');
        assert.deepEqual(hub, ['Your work', 'Needs you', 'Activity', 'Saved', 'Goals', 'Artifacts'], JSON.stringify(hub));
        assert.ok(!hub.includes('Saved for later'), 'the word is Saved, as on a computer');
        console.log('   ✓');

        console.log('3. Activity opens from the Hub sidebar, reads owner records and clears them on a 403');
        assert.equal(await ev(`window.__remoteRequests.filter(r=>r.path==='/api/activity').length`),0,'the visible Activity entry sends no read until opened');
        await ev(`(() => { const real=window.fetch; window.__activityReads=[]; window.__activityDeny=false;
            window.fetch=(u,o={})=>{ const p=new URL(String(u),location.href); if(p.pathname.endsWith('/api/activity')) {
                window.__activityReads.push({path:p.pathname,method:o.method||'GET'});
                const denied=window.__activityDeny===true || (window.__activityDeny==='m1'&&p.pathname.includes('/m1/'));
                return Promise.resolve(new Response(JSON.stringify(denied?{code:'owner_only',error:'owner_only'}:{actions:window.__activityEmpty?[]:[{id:1,at:'2026-11-21T10:00:00Z',action:'approve',item_kind:'file',item_id:'report',title:'Owner report',team:'release',source:'hub',actor:'Operator'}],check:{intact:true,rows:1},more:false}),{status:denied?403:200,headers:{'Content-Type':'application/json'}}));
            } return real(u,o);}; return true; })()`);
        await ev(`document.querySelector('nav.view-list-nav [data-key="activity"]').click(); true`);
        await waitFor(`document.querySelectorAll('#group-table-view .al-row').length===2`, 'owner Activity records from the two computers',10000);
        assert.ok((await ev(`document.querySelector('#group-table-view').textContent`)).includes('Owner report'));
        const reads=await ev(`window.__activityReads`);
        assert.deepEqual(reads.map(r=>r.path).sort(),['/api/remote/m1/api/activity','/api/remote/m2/api/activity']);
        assert.ok(reads.every(r=>r.method==='GET'),'Activity is read only');
        assert.equal(await ev(`!!document.querySelector('#group-table-view iframe.inbox-frame')`),false,'Activity is native, not a frame');
        await shot('hub-inbox-activity-owner');
        await ev(`window.__activityDeny=true; import(${S}+'inbox_activity.js').then(async m=>{await m.refresh();}).then(()=>true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .al-row').length===0`, 'owner-only refusal clears the previous records',10000);
        assert.ok(!(await ev(`document.querySelector('#group-table-view').textContent`)).includes('Owner report'),'no cached owner records after refusal');
        const refused = await ev(`import(${S}+'inbox_activity.js').then(m=>m.missingComputers())`);
        assert.equal(refused.length, 2);
        assert.ok(refused.every(r=>r.why.startsWith('refused to give its record')), 'both reads were owner-only refusals');
        await shot('hub-inbox-activity-refused');
        const desktopDenied = await ev(`document.querySelector('#group-table-view').textContent`);
        await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true}); await Emulation.setTouchEmulationEnabled({enabled:true});
        await ev(`import(${S}+'inbox_tab.js').then(m=>m.selectInboxTab('activity')).then(()=>true)`);
        await shot('hub-inbox-activity-refused-phone');
        const phoneDenied = await ev(`document.querySelector('#group-table-view').textContent`);
        for (const text of [desktopDenied, phoneDenied]) {
            assert.match(text,/Partial multi-computer view/,'all refused keeps the existing missing-computer notice');
            assert.match(text,/Laptop.*refused to give its record.*Desktop.*refused to give its record/,'both missing records are named');
            assert.doesNotMatch(text,/Nothing yet|Owner report/,'a refused record is neither empty nor a retained owner row');
        }
        assert.equal(await ev(`document.documentElement.scrollWidth>innerWidth+1`),false,'the refusal notice fits a phone');
        await ev(`window.__activityDeny=false;window.__activityEmpty=true;import(${S}+'inbox_activity.js').then(m=>m.refresh()).then(()=>true)`);
        await waitFor(`/Nothing yet/.test(document.querySelector('#group-table-view').textContent)&&!document.querySelector('.activity-check-partial')`,'a successful empty record is still empty');
        await shot('hub-inbox-activity-empty-phone');
        await ev(`window.__activityDeny='m1';window.__activityEmpty=false;import(${S}+'inbox_activity.js').then(m=>m.refresh()).then(()=>true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .al-row').length===1&&!!document.querySelector('.activity-check-partial')`,'the accessible computer keeps its row beside the refused source');
        await shot('hub-inbox-activity-partial-phone');
        await Emulation.setDeviceMetricsOverride({width:1280,height:844,deviceScaleFactor:1,mobile:false}); await Emulation.setTouchEmulationEnabled({enabled:false});
        console.log('   ✓');

        console.log('4. A Hub folder still opens its page: Saved frames the Hub page, Artifacts is the native list');
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
        await waitFor(`!!document.querySelector('#group-table-view iframe.inbox-frame')`, 'the Saved frame', 10000);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('artifacts')).then(() => true)`);
        await waitFor(`!document.querySelector('#group-table-view iframe.inbox-frame')`, 'Artifacts is not a frame (the Saved frame stays attached, hidden)', 10000);
        console.log('   ✓');
        console.log('PASS hub inbox sidebar: the Hub-served sidebar uses local\'s groups, order and words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
