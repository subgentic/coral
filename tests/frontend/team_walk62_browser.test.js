// #17320: first-time team friction, at a wide desktop and a phone.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const NT = require('./helpers/new_team');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, failures=[];
    const check=(ok,why)=>{if(!ok)failures.push(why);};
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for(const width of [1920,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:1080,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            // The explicit launch question focuses Continue; the next destructive question does not inherit it.
            await ev(`import(${S}+'launch_disclosure.js').then(m=>{window.__launchAnswer=null;m.confirmLaunchDisclosure('local',{id:'walk62',text:'Agents can act without asking.',seen:false}).then(v=>window.__launchAnswer=v);return true;})`);
            await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length>0`,'launch confirmation'); await ev(framesJs(2));
            check(await ev(`document.activeElement.id==='confirm-modal-yes'`),width+': Continue has initial focus');
            await ev(`window.hideConfirmModal();true`); await waitFor(`window.__launchAnswer===false`,'Cancel starts nothing');
            await ev(`window.showConfirmModal('Remove team?','This cannot be undone.',()=>{},undefined,{label:'Remove team',danger:true});true`); await ev(framesJs(2));
            check(await ev(`document.activeElement.id!=='confirm-modal-yes'`),width+': destructive confirmation keeps safe initial focus');
            await ev(`window.hideConfirmModal();true`);
            const text='The guide includes transport, restaurants, museums and useful prices for every neighbourhood.';
            const facts=await ev(`import(${S}+'saved.js').then(m=>m.savedItemFacts({id:1,server:'local',kind:'board',ref:'walk62',key:'one',title:'Guide writer',snippet:${JSON.stringify(text)},saved_at:new Date().toISOString()}))`);
            check(facts.snip===text && facts.which.includes(text),width+': Saved retains the whole available snippet');
            await ev(`(async()=>{const F=await import(${S}+'needs_filters.js'),L=await import(${S}+'list_bar.js');window.__qAfter=null;window.__walkBar=L.buildListBar({idp:'walk62',label:'Search items',noun:'item',searchLabel:'Search items',placeholder:'Search',fields:[],sorts:null,model:F},f=>window.__qAfter=f);document.body.append(window.__walkBar.node);window.__walkBar.set({...F.EMPTY,server:'other-box',q:'Lisbon'},{all:0,matched:0});return true;})()`);
            const chip=await ev(`window.__walkBar.node.querySelector('.list-bar-chip')?.textContent`);
            check(/Filtered by: Lisbon/.test(chip||''),width+': retained query is the first removable chip: '+chip);
            if(/Filtered by: Lisbon/.test(chip||'')) {await ev(`window.__walkBar.node.querySelector('.list-bar-chip').click();true`);await waitFor(`window.__qAfter?.q==='' && window.__qAfter.server==='other-box'`,'clear query without clearing computer');}
            await ev(`window.__walkBar.node.remove();true`);
            await ev(`import(${S}+'operator_ask_dialog.js').then(m=>m.openAskDialog({id:62,board:'walk62',asker:'Writer',kind:'ask',text:'Which neighbourhood?',at:new Date().toISOString()},()=>{}))`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open] textarea')`,'reply dialog');
            check(await ev(`document.querySelector('dialog.inbox-ask-dialog').textContent.includes('Ctrl/Cmd+Enter sends')`),width+': reply dialog explains how to send');
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-quiet)').click();true`);
            // An async trust card stays on Close; neither the redraw nor an arriving choice focuses Trust.
            await ev(`window.__cardFetch=window.fetch;window.fetch=(u,o)=>new URL(String(u),location.href).pathname==='/api/sessions/live/trust62/chat'?Promise.resolve(Response.json({prompt_options:{ask_id:'trust62',title:'Trust folder?',question:'Review this folder.',options:[{n:1,label:'No, exit'},{n:2,label:'Yes, I trust this folder'}]}})):window.__cardFetch(u,o);true`);
            await ev(`import(${S}+'inbox_agent_card.js').then(m=>m.openAgentCard({name:'trust62',session_id:'trust62',agent_type:'claude',waiting_kind:'permission',server:'local'}))`);
            await waitFor(`document.querySelectorAll('dialog.inbox-card-dialog .inbox-ask-offers-list button').length===2`,'trust choices arrived');
            check(await ev(`document.activeElement.textContent==='Close'`),width+': asynchronous trust choices leave Close focused');
            await ev(`document.activeElement.click();true`);
            await NT.install(ev); await NT.stubModels(ev); await NT.openNewTeam(ev,waitFor);const t=NT.T(ev,waitFor);
            await ev(`window.__folderFetch=window.fetch;window.fetch=(u,o)=>{const p=new URL(String(u),location.href);return p.pathname==='/api/filesystem/list'&&p.searchParams.get('path')==='/work/repo'?Promise.resolve(Response.json({path:'/work/repo',entries:['guides','notes','photos']})):window.__folderFetch(u,o);};document.getElementById('launch-team-dir').value='/work/repo';const b=document.getElementById('launch-team-dir').closest('.sv-row').querySelector('[data-on-click="m-toggle-browser"]');const ids=b.dataset.browser.split(' ');window.__folderBrowser=ids[1];window.__folderList=ids[2];b.click();true`);
            await waitFor(`document.getElementById(window.__folderList).querySelectorAll('li[data-name]').length===3`,'folder entries');
            const filter=await waitFor(`!!document.getElementById(window.__folderBrowser).querySelector('input[type=search]')`,'folder filter ready',3000).then(()=>true,()=>false);
            check(filter,width+': folder picker has a filter');
            if(filter) {await ev(`const i=document.getElementById(window.__folderBrowser).querySelector('input[type=search]');i.value='notes';i.dispatchEvent(new Event('input',{bubbles:true}));true`);check(await ev(`(()=>{const li=[...document.getElementById(window.__folderList).querySelectorAll('li[data-name]')].filter(e=>e.getClientRects().length>0);return li.length===1&&li[0].dataset.name==='notes';})()`),width+': folder filter matches the name');}
            await ev(`document.getElementById(window.__folderBrowser).querySelector('[data-on-click="m-browser-use"]').click();true`);
            await t.to(2);
            check(await ev(`/Choose a team template/.test(document.getElementById('team-members-host').textContent) && /coding roles/.test(document.getElementById('team-members-host').textContent)`),width+': template choice explains coding default');
            await t.click('button',NT.N.cancel);
        }
    } finally {await client.close();}
    assert.deepEqual(failures,[]);console.log('PASS walk62 focus, full Saved snippets, retained-query chips, reply shortcut, folder filtering and explicit template choice');
})().catch(e=>{console.error(e);process.exitCode=1;});
