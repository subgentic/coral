// #7818: Goals and Artifacts selection survives filtering; per-item actions keep failures selected.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'bulk-' + Date.now().toString(36), A = 'a'.repeat(64), C = 'b'.repeat(64);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}}).then(async r=>({status:r.status,body:await r.json()}))`);
    const shot = async name => { const dir=process.env.CORAL_SCREENSHOT_DIR;if(!dir)return;const fs=require('node:fs');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const search = async (panel, value) => { await ev(`(()=>{const i=${q(panel+' .list-bar-search')};i.value=${JSON.stringify(value)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await Emulation.setDeviceMetricsOverride({width:1280,height:800,deviceScaleFactor:1,mobile:false});
        await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
        await api('POST',`/api/board/${B}/subscribe`,{subscriber_id:'orch',job_title:'Orchestrator'});
        for (const title of ['Alpha goal','Beta goal']) { const r=await api('POST',`/api/board/${B}/goals`,{title,subscriber_id:'Operator',done_when:'Ready'}); assert.ok(r.status<300,JSON.stringify(r)); }
        await api('POST',`/api/board/${B}/tasks`,{title:'No goal task',created_by:'orch'});
        await ev(`window.openTeamPage(${JSON.stringify(B)},{tab:'goals'});true`);
        const G='#team-panel-goals';
        await waitFor(`${q(G+' .dt-check-all')} && ${q(G+' .dt-table')}.querySelectorAll('tbody tr').length === 3`,'goals and no-goal row',15000);
        assert.equal(await ev(`${q(G+' tr[data-key="no-goal"] input')}.disabled`),true,'navigation row cannot be selected');
        await ev(`${q(G+' .dt-check-all')}.click();true`);
        assert.equal(await ev(`${q(G+' .dt-bar-count')}.textContent`),'2 selected');
        await search(G,'Beta');
        await waitFor(`${q(G+' .dt-table')}.querySelectorAll('tbody tr:not([data-key="no-goal"])').length===1`,'filtered goals');
        assert.equal(await ev(`${q(G+' .dt-bar-count')}.textContent`),'2 selected');
        await ev(`${q(G+' .dt-bar-action')}.click();true`);
        await waitFor(`!!${q(G+' .dt-bar-text')}`,'close reason');
        assert.equal(await ev(`${q(G+' .dt-bar-apply')}.disabled`),true,'reason is required');
        await shot('goals-close-selected');
        assert.equal(await ev(`document.activeElement.classList.contains('dt-bar-keep')`),true,'destructive choice starts on Keep');
        await ev(`(()=>{const i=${q(G+' .dt-bar-text')};i.value='Finished together';i.dispatchEvent(new Event('input',{bubbles:true}));${q(G+' .dt-bar-apply')}.click();return true;})()`);
        await waitFor(`!${q(G+' .team-toolbar-selecting')}`,'selection clears after closing',10000);
        const goals=(await api('GET',`/api/board/${B}/goals`)).body;
        assert.ok((Array.isArray(goals)?goals:goals.goals).every(g=>g.state==='done'),'both selected goals close, including the hidden one');
        // Stub artifact storage; never delete real files. One failure must remain selected.
        await ev(`(()=>{const original=fetch.bind(window);window.__deletes=[];window.__downloads=[];window.__fail=true;let items=[{id:'${A}',uri:'coral://artifacts/${A}',name:'Alpha.txt',available:true},{id:'${C}',uri:'coral://artifacts/${C}',name:'Beta.txt',available:true},{id:'${'c'.repeat(64)}',name:'Unverified',available:false,provenance:'unverified'}];const json=(b,status=200)=>Promise.resolve(new Response(JSON.stringify(b),{status,headers:{'Content-Type':'application/json'}}));HTMLAnchorElement.prototype.click=function(){if(this.download)window.__downloads.push(this.download);};window.fetch=(u,o={})=>{const url=new URL(String(u),location.origin);if(url.pathname==='/api/board/${B}/artifacts'){const filter=url.searchParams.get('q')||'';const rows=items.filter(i=>i.name.toLowerCase().includes(filter.toLowerCase()));return json({project:'${B}',artifacts:rows,total:rows.length,all:items.length,has_more:false});}if(url.pathname==='/api/system/artifact-store/kept')return json({kept:[]});if((o.method||'GET')==='DELETE'&&url.pathname.startsWith('/api/artifacts/')){const id=url.pathname.split('/').pop();window.__deletes.push(id);if(id==='${C}'&&window.__fail)return json({error:'try again'},500);items=items.filter(i=>i.id!==id);return json({ok:true});}return original(u,o);};return true;})()`);
        await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});
        await ev(`window.openTeamPage(${JSON.stringify(B)},{tab:'artifacts'});true`);
        const P='#team-panel-artifacts';
        await waitFor(`${q(P+' tbody')}?.children.length===3`,'artifact rows',15000);
        await ev(`${q(P+' .dt-select-toggle')}.click();true`);
        assert.ok(await ev(`${q(P+' .dt-select-toggle')}.getBoundingClientRect().height>=44`),'phone Select is a touch target');
        await ev(`(()=>{const cs=[...document.querySelectorAll('${P} tbody .dt-check input:not(:disabled)')];cs[0].click();cs[1].focus();return true;})()`);
        await client.Input.dispatchKeyEvent({type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
        await client.Input.dispatchKeyEvent({type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
        assert.equal(await ev(`${q(P+' .dt-bar-count')}.textContent`),'2 selected','unverified excluded');
        await shot('artifacts-selected-phone');
        await search(P,'Beta'); await waitFor(`${q(P+' tbody')}?.children.length===1`,'filtered artifact');
        await ev(`${q(P+' .dt-bar-action')}.click();true`);
        await waitFor(`window.__downloads.length===2`,'both downloads');
        assert.deepEqual((await ev(`window.__downloads`)).sort(),['Alpha.txt','Beta.txt']);
        await search(P,''); await waitFor(`${q(P+' tbody')}?.children.length===3`,'clear artifact filter');
        await ev(`[...document.querySelectorAll('${P} tbody .dt-check input:not(:disabled)')].forEach(c=>c.click());[...document.querySelectorAll('${P} .dt-bar-action')].find(b=>b.textContent==='Delete').click();true`);
        assert.deepEqual(await ev(`window.__deletes`),[],'Delete first asks');
        await ev(`${q(P+' .dt-bar-keep')}.click();true`); assert.deepEqual(await ev(`window.__deletes`),[],'Keep does not delete');
        await ev(`[...document.querySelectorAll('${P} .dt-bar-action')].find(b=>b.textContent==='Delete').click();${q(P+' .dt-bar .dt-danger')}.click();true`);
        await waitFor(`window.__deletes.length===2 && ${q(P+' .dt-bar-count')}?.textContent==='1 selected'`,'failed artifact remains selected',10000);
        await ev(`window.__fail=false;[...document.querySelectorAll('${P} .dt-bar-action')].find(b=>b.textContent==='Delete').click();${q(P+' .dt-bar .dt-danger')}.click();true`);
        await waitFor(`window.__deletes.length===3 && !${q(P+' .team-toolbar-selecting')}`,'retry completes',10000);
        console.log('PASS Goals/Artifacts bulk actions: filtering, required reason, eligibility, confirmation and partial failure');
    } finally { await removeBoards(ev,[B]).catch(()=>{}); await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
