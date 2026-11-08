// #14101: the existing one-file Inbox URL also opens Saved reviews, from a
// source-qualified cache or an exact protected lookup on a cold Hub page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const HEX = 'a'.repeat(64), DECIDED = 'b'.repeat(64), REVIEW_ONLY = 'c'.repeat(64), SAVED_ONLY = 'd'.repeat(64);
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic||'/static/')`;
    try {
        await setupHubWorld({ client, Page, Emulation, width:1280, height:900, mobile:false, inbox:'native', needs:true, hubPages:true });
        await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{
            const original=window.fetch, json=(body,status=200)=>Promise.resolve(Response.json(body,{status}));
            window.__savedLink={lookups:[],bare:[],byteReads:[],forbidLookup:false};
            window.fetch=(input,options={})=>{
                const u=new URL(String(input),location.href), method=options.method||'GET';
                if(u.pathname==='/api/team-artifacts'){window.__savedLink.bare.push(u.pathname);return json({error:'owner_only'},403);}
                const parts=u.pathname.split('/');
                if(parts[1]!=='api'||parts[2]!=='remote'||!['m1','m2'].includes(parts[3]))return original(input,options);
                const server=parts[3], path='/'+parts.slice(4).join('/'), name=server==='m1'?'Laptop saved.md':'Desktop saved.md';
                const artifact={id:'${HEX}',uri:'coral://artifacts/${HEX}',board_id:'same',team:'Same team',name,media_type:'text/markdown',available:true,tags:['for review','saved'],produced_by:'Writer',session_id:'writer-'+server,created_at:'2026-11-01T00:00:00Z'};
                if(path==='/api/board/projects')return json([{project:'same',board_id:'same',board_label:'Same team'}]);
                if(path==='/api/team-artifacts'){
                    const digest=u.searchParams.get('digest');
                    if(digest){window.__savedLink.lookups.push({server,team:u.searchParams.get('team'),digest,tag:u.searchParams.get('tag')});if(window.__savedLink.forbidLookup&&u.searchParams.get('tag')==='for review')return json({error:'lookup unavailable'},503);}
                    const partials={'${REVIEW_ONLY}':['for review'],'${SAVED_ONLY}':['saved','approved']};
                    let rows=partials[digest]?[{...artifact,id:digest,uri:'coral://artifacts/'+digest,tags:partials[digest]}]:digest==='${DECIDED}'?[{...artifact,id:'${DECIDED}',uri:'coral://artifacts/${DECIDED}',tags:['approved']}]:[artifact];
                    if(u.searchParams.get('tag')==='for review'||u.searchParams.has('waiting'))rows=[];
                    if(digest&&!['${HEX}','${DECIDED}','${REVIEW_ONLY}','${SAVED_ONLY}'].includes(digest))rows=[];
                    if(u.searchParams.has('team')&&u.searchParams.get('team')!=='same')rows=[];
                    return json({artifacts:rows,total:rows.length,all:rows.length,teams:[],has_more:false,tag_counts:rows.length?{'for review':1,saved:1}:{}});
                }
                const partialID=path.split('/')[3];
                if(['${REVIEW_ONLY}','${SAVED_ONLY}'].includes(partialID)){
                    if(path==='/api/artifacts/'+partialID&&method==='GET'){
                        window.__savedLink.byteReads.push(partialID);
                        return Promise.resolve(new Response('# Partial-tag bytes',{headers:{'content-type':'text/markdown'}}));
                    }
                    if(path.endsWith('/meta'))return json({...artifact,id:partialID,uri:'coral://artifacts/'+partialID});
                    if(path.endsWith('/versions'))return json({versions:[]});
                    if(path.endsWith('/readers'))return json({readers:[]});
                    if(path.endsWith('/comments'))return json({comments:[],you:{can_comment:false},locked:false});
                    if(path.endsWith('/opened'))return json({ok:true});
                }
                if(path==='/api/artifacts/${HEX}'&&method==='GET')return Promise.resolve(new Response('# Saved review bytes',{headers:{'content-type':'text/markdown'}}));
                if(path==='/api/artifacts/${HEX}/meta')return json(artifact);
                if(path==='/api/artifacts/${HEX}/versions')return json({versions:[]});
                if(path==='/api/artifacts/${HEX}/readers')return json({readers:[]});
                if(path==='/api/artifacts/${HEX}/comments')return json({comments:[],you:{can_comment:false},locked:false});
                if(path==='/api/artifacts/${HEX}/opened')return json({ok:true});
                return original(input,options);
            };
        })()`});
        for(const width of [1280,390]){
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','settings');
            await ev(`import(${S}+'state.js').then(m=>{window.__savedLinkState=m.state;})`);
            await waitFor(`window.__savedLinkState?.servers?.some(s=>s.id==='m2'&&s.status==='online')`,'Hub computer inventory ready');
            const open = (server,id=HEX) => ev(`import(${S}+'inbox_link.js').then(m=>m.openNeed({kind:'review',server:'${server}',team:'same',id:'${id}'}))`);
            assert.equal(await ev(`import(${S}+'inbox_reviews.js').then(m=>m.savedFiles().length)`),0,'cold link starts without Saved cache rows');
            await open('m2');
            await waitFor(`document.querySelector('.artifact-viewer-title')?.textContent==='Desktop saved.md'&&!document.querySelector('#artifact-viewer')?.hidden`,width+': cold Saved link opens on its own computer');
            const cold=await ev('window.__savedLink.lookups');
            assert.deepEqual(cold.slice(0,2).map(r=>[r.server,r.team,r.digest,r.tag]),[['m2','same',HEX,'for review'],['m2','same',HEX,null]],'cold fallback stays on the same protected computer/board/digest');
            assert.ok(cold.every(r=>r.server==='m2'&&r.team==='same'&&r.digest===HEX),'viewer review-state reads keep the same protected source scope');
            await ev(`document.querySelector('.artifact-viewer-close').click();true`);
            await ev(`import(${S}+'inbox_reviews.js').then(m=>m.activateSavedReviews())`); // Saved is now lazy; wait for its explicit activation before asserting cached rows
            assert.equal(await ev(`import(${S}+'inbox_reviews.js').then(m=>m.savedFiles().length)`),2,'both computers have a source-qualified Saved row');
            await ev(`window.__savedLink.forbidLookup=true;window.__savedLink.lookups=[];true`);
            for(const [server,title] of [['m2','Desktop saved.md'],['m1','Laptop saved.md']]){
                await ev(`window.__savedLink.lookups=[];true`);
                await open(server);
                await waitFor(`document.querySelector('.artifact-viewer-title')?.textContent===${JSON.stringify(title)}&&!document.querySelector('#artifact-viewer')?.hidden`,width+': cached Saved row opens on '+server);
                assert.ok((await ev('window.__savedLink.lookups')).every(r=>r.server===server&&r.team==='same'&&r.digest===HEX&&r.tag===null),'warm opener uses cached Saved rows; viewer may refresh its own exact review state');
                await ev(`document.querySelector('.artifact-viewer-close').click();true`);
            }
            assert.deepEqual(await ev('window.__savedLink.bare'),[],'no fallback to the Hub local list');
            await ev(`window.__savedLink.forbidLookup=false;true`);
            for(const [id,label] of [[REVIEW_ONLY,'for-review-only'],[SAVED_ONLY,'saved-only decided']]){
                await ev(`document.querySelectorAll('.toast').forEach(t=>t.remove());window.__savedLink.lookups=[];window.__savedLink.byteReads=[];true`);
                await open('m2',id);
                await waitFor(`Array.from(document.querySelectorAll('.toast')).some(t=>t.textContent.includes('That file is not waiting for you any more.'))`,label+': cold lookup refuses a missing required tag');
                assert.equal(await ev(`document.querySelector('#artifact-viewer')?.hidden`),true,label+': missing required tag never opens the viewer');
                assert.deepEqual(await ev('window.__savedLink.byteReads'),[],label+': missing required tag never reads file bytes');
                assert.deepEqual((await ev('window.__savedLink.lookups')).map(r=>[r.server,r.team,r.digest,r.tag]),[['m2','same',id,'for review'],['m2','same',id,null]],label+': exercises exact protected cold fallback');
            }
            await open('m2',DECIDED);
            await waitFor(`Array.from(document.querySelectorAll('.toast')).some(t=>t.textContent.includes('That file is not waiting for you any more.'))`,'non-Saved decided file stays unavailable');
            assert.equal(await ev(`document.querySelector('#artifact-viewer')?.hidden`),true,'the Saved fallback never opens an unrelated decided file');
        }
        console.log('inbox_saved_file_link_browser: cold/warm source-qualified Saved links and decided refusal pass');
    } finally { await client.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
