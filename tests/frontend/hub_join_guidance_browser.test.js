// #20967 v3: remote join management belongs to the Hub's own UI. Coral's
// computer pages show only guidance, with no join controls or secret reads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
// Served by a Hub (#21088) the Hub has no page for this yet, so the line names only the computer; a local Coral that is not a Hub keeps the longer one (#20967).
const WORDS = { hub: 'Allow new Hubs and manage keys at the computer.', local: "Allow new Hubs and manage keys on your Hub's page for this computer, or at the computer." };
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
            window.__joinReads=[];
            window.fetch=(u,o={})=>{const p=new URL(String(u),location.href).pathname;
                if(p.includes('/api/cloud/link-')){window.__joinReads.push(p);return json({});}
                if(p==='/api/sessions/live')return json({sessions:[],servers:[server]});
                if(p==='/api/servers')return json(window.__qaCloud?{servers:[server]}:[server]);
                if(p==='/api/health')return real(u,o).then(async r=>Response.json({...await r.json(),hub:window.__qaHub!==false}));
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
        for (const [source, hub] of [['registered', true], ['registered', false], ['cloud', true]]) for (const width of [1280,390]) for (const theme of ['dark','light']) {
            cloud=source==='cloud';
            await Page.addScriptToEvaluateOnNewDocument({source:`window.__qaCloud=${cloud};window.__qaHub=${hub};localStorage.setItem('coral-theme','${theme}');`});
            await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width===390});
            const blank=Page.loadEventFired();await Page.navigate({url:'about:blank'});await blank;
            const loaded=Page.loadEventFired();await Page.navigate({url:BASE+'/'});await loaded;await install();await waitFor(`typeof window.switchNavTab==='function'`,'navigation ready',10000);
            await ev(`window.switchNavTab('servers');true`);
            await waitFor(`!!document.querySelector('#servers-view .dt-row[data-key="build-mac"]')`,'computer row',10000).catch(async e=>{throw Error(e.message+' '+JSON.stringify(await ev(`({source:window.__qaCloud,boot:document.getElementById('coral-boot')?.textContent,view:document.getElementById('servers-view')?.textContent?.slice(0,1200),rows:[...document.querySelectorAll('[data-key]')].map(n=>[n.className,n.dataset.key]).slice(0,15)})`)));});
            await ev(`document.querySelector('#servers-view .dt-row[data-key="build-mac"] [data-action="open"], #servers-view .dt-row[data-key="build-mac"] .dt-primary, #servers-view .dt-row[data-key="build-mac"] .cs-open').click();true`);
            await waitFor(`!!document.querySelector('.servers-page [data-hub-join-guidance]')`,'remote join guidance',5000);
            assert.equal(await ev(`document.querySelector('[data-hub-join-guidance]').textContent`),hub ? WORDS.hub : WORDS.local, `${source} hub=${hub}: the guidance line`);
            assert.equal(await ev(`!!document.querySelector('[data-join-request], #hub-join-keys, [data-hub-join-guidance] button, [data-hub-join-guidance] a')`),false,'guidance has no controls and remote join panels stay hidden');
            assert.deepEqual(await ev(`window.__joinReads`),[],'no join API or secret reads');
            await ev(`document.querySelector('[data-hub-join-guidance]').scrollIntoView({block:'center',behavior:'instant'});true`);
            assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`),true,'no horizontal overflow');
            assert.equal(await ev(`(()=>{const n=document.querySelector('[data-hub-join-guidance]'),r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`),true,'whole guidance visible');
            if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/guidance-'+source+(hub?'':'-local')+'-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
        }
        console.log('PASS remote join guidance: both computer pages, phone/desktop, dark/light; no join controls or API reads');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
