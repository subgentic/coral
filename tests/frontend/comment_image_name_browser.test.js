const { draftReviewStub, sendSavedDrafts } = require('./helpers/draft_review_stub');
// #20991: sent comment pictures survive artifact name lookup, locally and through cloud routing.
// Four pictures per comment are accepted; the fifth is refused with words and no upload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const HEX='d'.repeat(64);
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch } = client; let cloud = false;
    try {
        await Page.enable();
        await client.Network.enable();
        await client.Network.setCacheDisabled({cacheDisabled:true});
        await client.Network.setBypassServiceWorker({bypass:true});
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real=window.fetch.bind(window), json=x=>Promise.resolve(Response.json(x));
            window.__comments=[];window.__uploads=[];window.__meta=[];window.__metaDone=0;
            window.__pick=()=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0))],'picture.png',{type:'image/png'}));const i=document.querySelector('.ac-composer .ac-picker input');i.files=dt.files;i.dispatchEvent(new Event('change'));};
            const server={id:'build-mac',label:'Build Mac',url:'https://build-mac.example',online:true,status:'online',access_mode:'interact',local_mode:'interact',version:'2.1.8',agents:0};
            window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;
                if(p==='/api/account')return json({comment_writes:true,comment_send:true});
                if(p.endsWith('/comment-images')){const hex='e'.repeat(63)+(window.__uploads.length+1).toString(16);window.__uploads.push(String(u));return Promise.resolve(Response.json({hex,name:'picture.png',content_type:'image/png',size:o.body.size},{status:201}));}
                if(p.includes('/api/artifacts/'+ 'e'.repeat(63)) && p.endsWith('/meta'))return new Promise(resolve=>window.__meta.push(()=>{window.__metaDone++;resolve(Response.json({name:'stored-picture.png'}));}));
                if(p.endsWith('/api/artifacts/${HEX}/comments')){if(o.method==='POST'){const b=JSON.parse(o.body),c={id:window.__comments.length+1,body:b.body,anchor:b.anchor,images:b.images.map(hex=>({hex,name:'picture.png',content_type:'image/png'})),author:{kind:'owner',subject:'Operator'},created_at:new Date().toISOString(),can:{reply:false,edit:false,delete:false,resolve:false}};window.__comments.push(c);return Promise.resolve(Response.json(c,{status:201}));}return json({comments:window.__comments,locked:false,you:{kind:'owner',name:'Operator',can_comment:true,can_lock:true},limits:{body:8192}});} 
                if(p.endsWith('/api/artifacts/${HEX}'))return Promise.resolve(new Response('# Plan\\n\\nA picture in a comment.',{headers:{'Content-Type':'text/markdown'}}));
                if(p==='/api/sessions/live'){window.__liveListServed=(window.__liveListServed||0)+1;return json({sessions:[],servers:[server]});}
                if(p==='/api/servers')return json(window.__qaCloud?{servers:[server]}:[server]);
                if(p==='/api/health')return real(u,o).then(async r=>Response.json({...await r.json(),hub:window.__qaCloud}));
                if(p==='/api/servers/provision')return json({plans:[]});
                return real(u,o);};
        })();` });
        await Fetch.enable({ patterns: [{ urlPattern: BASE+'/*', resourceType:'Document', requestStage:'Response' },{urlPattern:BASE+'/auth/session',requestStage:'Request'},{urlPattern:'*/api/artifacts/eeeeeeee*',resourceType:'Image',requestStage:'Request'}] });
        safePaused(client, async e => {
            if(e.resourceType==='Image')return Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'}],body:PNG});
            if(e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({authenticated:true,email:'qa@example.com',csrf:'qa-csrf'})).toString('base64')});
            if(e.responseStatusCode!==200)return Fetch.continueRequest({requestId:e.requestId});
            const r=await Fetch.getResponseBody({requestId:e.requestId});
            const html=(r.base64Encoded?Buffer.from(r.body,'base64').toString('utf8'):r.body).replace('"mode":"local"','"mode":"'+(cloud?'cloud':'local')+'"');
            return Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:(e.responseHeaders||[]).filter(h=>!/^content-(length|encoding)$/i.test(h.name)),body:Buffer.from(html).toString('base64')});
        });
        for (const source of ['local','cloud']) for (const width of [1280,390]) for (const surface of ['viewer','preview']) {
            const root=surface==='preview'?'#preview-main':'#artifact-viewer', toggleRoot=surface==='preview'?'#preview-pane':'#artifact-viewer';
            cloud=source==='cloud';
            await Page.addScriptToEvaluateOnNewDocument({source:`window.__qaCloud=${cloud};`});
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            const blank=Page.loadEventFired();await Page.navigate({url:'about:blank'});await blank;
            const loaded=Page.loadEventFired();await Page.navigate({url:BASE+'/'});await loaded;await install();await ev(draftReviewStub(HEX));
            if(surface==='preview') await ev(`(async()=>{const path=(window.__coralStatic||'/static/');const {state}=await import(path+'state.js');state.currentSession={type:'live',name:'Dev',session_id:'picker-agent',agent_type:'claude',server:'${cloud?'build-mac':'local'}'};const {showView}=await import(path+'utils.js');showView('live-session-view');const p=await import(path+'preview_pane.js');p.setPreviewSession('picker-agent');p.openArtifactTab('coral://artifacts/${HEX}',{filename:'plan.md',mediaType:'text/markdown',server:'${cloud?'build-mac':'local'}',phoneFull:true});return true;})()`);
            else await ev(`(async()=>{const v=await import((window.__coralStatic||'/static/')+'artifact_viewer.js');v.openArtifactViewer('${HEX}',{filename:'plan.md',mediaType:'text/markdown'${cloud?",server:'build-mac'":''}});return true;})()`);
            await waitFor(`!!document.querySelector('${root} .ac-panel')`,'document',10000);
            await waitFor(`!!document.querySelector('${toggleRoot} .ac-toggle:not([hidden])')`,'Comments action',10000);
            await ev(`(()=>{const t=document.querySelector('${toggleRoot} .ac-toggle');if(t.getAttribute('aria-expanded')!=='true')t.click();return true;})()`);
            await waitFor(`!!document.querySelector('${root} .ac-composer .ac-input, ${root} .ac-whole')`,'whole-document composer or preview launcher',10000);
            await ev(`document.querySelector('${root} .ac-whole')?.click();true`);
            await waitFor(`!!document.querySelector('${root} .ac-composer .ac-add-image')`,'comment picker',10000);
            const tag=source+' '+width+' '+surface;
            const send=async()=>{
                await ev(`(()=>{const t=document.querySelector('${root} .ac-composer .ac-input');t.value='coral://artifacts/'+('e'.repeat(63)+'1');t.dispatchEvent(new Event('input'));document.querySelector('${root} .ac-composer').requestSubmit();return true;})()`);
                await waitFor(`window.__drafts.length===1`,tag+' private save',8000);
                if (await ev(`window.__comments.length !== window.__draftWrites.filter(w=>w.method==='POST').length - 1`)) throw new Error(tag+' Save draft published a comment');
                await sendSavedDrafts(ev,waitFor,root);
                await waitFor(`document.querySelectorAll('${root} .ac-card').length===window.__comments.length && (!document.querySelector('${root} .ac-composer .ac-input') || document.querySelector('${root} .ac-composer .ac-input').value==='')`,tag+' sent',8000);
            };
            await ev(`window.__pick();true`);
            await waitFor(`document.querySelectorAll('${root} .ac-thumb-ready').length===1`,tag+' first upload',5000);
            await send();
            await waitFor(`window.__meta.length===1`,tag+' pending name lookup',5000);
            await ev(`window.__meta.splice(0).forEach(f=>f());true`);
            await waitFor(`document.querySelector('${root} .ac-body a.mb-artifact-ref')?.textContent==='stored-picture.png'`,tag+' name response applied',5000);
            assert.equal(await ev(`document.querySelectorAll('${root} .ac-card .ac-pic-img').length`),1,tag+' name lookup preserves the sent picture without reload');
            await ev(`document.querySelector('${root} .ac-whole')?.click();true`);
            for(let n=1;n<=4;n++){
                await ev(`window.__pick();true`);
                await waitFor(`document.querySelectorAll('${root} .ac-thumb-ready').length===${n}`,tag+' upload '+n,5000);
            }
            await ev(`window.__pick();true`);
            assert.equal(await ev(`window.__uploads.length`),5,tag+' first comment plus four new uploads; fifth add makes no call');
            assert.match(await ev(`document.querySelector('${root} .ac-images-note').textContent`),/at most 4 pictures/,tag+' fifth picture refusal says the cap');
            await send();
            assert.equal(await ev(`window.__comments[1].images.length`),4,tag+' second comment carries four pictures');
            await ev(`[...document.querySelectorAll('${root} .ac-pic-img')].forEach(i=>i.loading='eager');true`);
            await waitFor(`document.querySelectorAll('${root} .ac-pic-img').length===5 && [...document.querySelectorAll('${root} .ac-pic-img')].every(i=>i.complete&&i.naturalWidth>0)`,tag+' all five pictures drawn',8000);
            assert.ok(await ev(`window.__uploads.every(u=>${cloud}?u.startsWith('/api/remote/build-mac/'):!u.startsWith('/api/remote/'))`),tag+' uploads use captured source');
            console.log('PASS',tag,'five stored and drawn across two comments; fifth per-comment add visibly refused');
            if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/sent-'+source+'-'+width+'-'+surface+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
        }
        console.log('PASS sent comment pictures and explicit cap on local and cloud pages');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
