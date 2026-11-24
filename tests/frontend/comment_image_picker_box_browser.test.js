// #20985: a hidden board picker must not stand in for the active comment picker.
// Check the real box and chooser click in modal/docked comments, locally and through cloud routing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const HEX='d'.repeat(64);
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
            const server={id:'build-mac',label:'Build Mac',url:'https://build-mac.example',online:true,status:'online',access_mode:'interact',local_mode:'interact',version:'2.1.8',agents:0};
            window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;
                if(p==='/api/account')return json({comment_writes:true,comment_send:true});
                if(p.endsWith('/api/artifacts/${HEX}/comments'))return json({comments:[],locked:false,you:{kind:'owner',name:'Operator',can_comment:true,can_lock:true},limits:{body:8192}});
                if(p.endsWith('/api/artifacts/${HEX}'))return Promise.resolve(new Response('# Plan\\n\\nA picture in a comment.',{headers:{'Content-Type':'text/markdown'}}));
                if(p==='/api/sessions/live'){window.__liveListServed=(window.__liveListServed||0)+1;return json({sessions:[],servers:[server]});}
                if(p==='/api/servers')return json(window.__qaCloud?{servers:[server]}:[server]);
                if(p==='/api/health')return real(u,o).then(async r=>Response.json({...await r.json(),hub:window.__qaCloud}));
                if(p==='/api/servers/provision')return json({plans:[]});
                return real(u,o);};
        })();` });
        await Fetch.enable({ patterns: [{ urlPattern: BASE+'/*', resourceType:'Document', requestStage:'Response' },{urlPattern:BASE+'/auth/session',requestStage:'Request'}] });
        safePaused(client, async e => {
            if(e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({authenticated:true,email:'qa@example.com',csrf:'qa-csrf'})).toString('base64')});
            if(e.responseStatusCode!==200)return Fetch.continueRequest({requestId:e.requestId});
            const r=await Fetch.getResponseBody({requestId:e.requestId});
            const html=(r.base64Encoded?Buffer.from(r.body,'base64').toString('utf8'):r.body).replace('"mode":"local"','"mode":"'+(cloud?'cloud':'local')+'"');
            return Fetch.fulfillRequest({requestId:e.requestId,responseCode:200,responseHeaders:(e.responseHeaders||[]).filter(h=>!/^content-(length|encoding)$/i.test(h.name)),body:Buffer.from(html).toString('base64')});
        });
        await Page.setInterceptFileChooserDialog({enabled:true});
        let choose;Page.fileChooserOpened(e=>{choose?.(e);});
        for (const source of ['local','cloud']) for (const width of [1280,390]) for (const surface of ['viewer','preview']) {
            const root=surface==='preview'?'#preview-main':'#artifact-viewer', toggleRoot=surface==='preview'?'#preview-pane':'#artifact-viewer';
            cloud=source==='cloud';
            await Page.addScriptToEvaluateOnNewDocument({source:`window.__qaCloud=${cloud};`});
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            const blank=Page.loadEventFired();await Page.navigate({url:'about:blank'});await blank;
            const loaded=Page.loadEventFired();await Page.navigate({url:BASE+'/'});await loaded;await install();
            // A board composer remains mounted when another page is open. Its
            // hidden Add image must not be mistaken for the active comment's.
            await ev(`import((window.__coralStatic||'/static/')+'board_composer.js').then(m=>{m.mountBoardPictures('picker-team');return true;})`);
            if(surface==='preview') await ev(`(async()=>{const path=(window.__coralStatic||'/static/');const {state}=await import(path+'state.js');state.currentSession={type:'live',name:'Dev',session_id:'picker-agent',agent_type:'claude',server:'${cloud?'build-mac':'local'}'};const {showView}=await import(path+'utils.js');showView('live-session-view');const p=await import(path+'preview_pane.js');p.setPreviewSession('picker-agent');p.openArtifactTab('coral://artifacts/${HEX}',{filename:'plan.md',mediaType:'text/markdown',server:'${cloud?'build-mac':'local'}',phoneFull:true});return true;})()`);
            else await ev(`(async()=>{const v=await import((window.__coralStatic||'/static/')+'artifact_viewer.js');v.openArtifactViewer('${HEX}',{filename:'plan.md',mediaType:'text/markdown'${cloud?",server:'build-mac'":''}});return true;})()`);
            await waitFor(`!!document.querySelector('${root} .ac-panel')`,'document',10000);
            await waitFor(`!!document.querySelector('${toggleRoot} .ac-toggle:not([hidden])')`,'Comments action',10000);
            await ev(`(()=>{const t=document.querySelector('${toggleRoot} .ac-toggle');if(t.getAttribute('aria-expanded')!=='true')t.click();return true;})()`);
            await waitFor(`!!document.querySelector('${root} .ac-whole')`,'whole-document action',10000);
            await ev(`document.querySelector('${root} .ac-whole').click();true`);
            await waitFor(`!!document.querySelector('${root} .ac-composer .ac-add-image')`,'comment picker',10000);
            const box=await ev(`(()=>{const btn=document.querySelector('${root} .ac-composer .ac-add-image');btn.scrollIntoView({block:'nearest',behavior:'instant'});const r=btn.getBoundingClientRect(),first=document.querySelector('.ac-add-image'),fr=first.getBoundingClientRect();const ancestors=[];for(let n=first;n;n=n.parentElement){const s=getComputedStyle(n);ancestors.push({tag:n.tagName,id:n.id,cls:n.className,display:s.display,hidden:n.hidden,rects:n.getClientRects().length});}return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,rects:btn.getClientRects().length,globalFirstIsComposer:first===btn,globalRect:[fr.width,fr.height],ancestors};})()`);
            console.log('PICKER',source,width,surface,JSON.stringify(box));
            assert.equal(box.globalFirstIsComposer,false,'the document-wide selector belongs to another form');
            assert.deepEqual(box.globalRect,[0,0],'the hidden board picker reproduces the reported global 0x0 reading');
            assert.ok(box.w>0&&box.h>0&&box.rects>0,'the actual composer picker has a layout box');
            assert.equal(await ev(`(()=>{const b=document.querySelector('${root} .ac-composer .ac-add-image'),r=b.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===b||b.contains(h);})()`),true,'picker is physically clickable');
            let timer;const opened=new Promise((resolve,reject)=>{choose=resolve;timer=setTimeout(()=>reject(Error('image picker did not open')),3000);});
            await client.Input.dispatchMouseEvent({type:'mouseMoved',x:box.x,y:box.y});
            await client.Input.dispatchMouseEvent({type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1});
            await client.Input.dispatchMouseEvent({type:'mouseReleased',x:box.x,y:box.y,button:'left',clickCount:1});
            try{assert.equal((await opened).mode,'selectMultiple','a real click opens the multiple-image picker');}finally{clearTimeout(timer);choose=null;}
            if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/picker-'+source+'-'+width+'-'+surface+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
        }
        console.log('PASS actual comment Add image box and click on local and cloud pages');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
