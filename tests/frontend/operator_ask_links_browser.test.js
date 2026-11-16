// #17769: server-linked asks with different wording share one question; server answers/goal retirement remain authoritative.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:844,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
            await ev(`(async()=>{
                window.__m=await import((window.__coralStatic||'/static/')+'operator_asks.js');
                const buttons=[{id:1,label:'Yes',action:'reply',state:'pending'},{id:2,label:'No',action:'reply',state:'pending'}];
                const a={board:'release',kind:'ask',id:41,key:41,asker:'Lead',text:'@Operator Ship this version?',goal_id:2,buttons,at:'2026-11-15T01:00:00Z'};
                window.__seed=[a,{...a,id:42,asker:'QA',text:'@Operator May I close goal 2 with this build?'},{...a,id:43,key:43,text:'@Operator Ship this version?'},{...a,id:44,board:'other',asker:'Other team'}];
                window.__asks=structuredClone(window.__seed);window.__fail=true;window.__closed=0;window.__answers=0;
                const orig=window.fetch.bind(window),json=(x,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}}));
                const answer=()=>{if(window.__fail)return json({error:'retry later'},429);window.__answers++;window.__asks=window.__asks.filter(x=>!(x.board==='release'&&x.key===41));return json({id:99,action:'reply',label:'No'});};
                window.fetch=(u,o={})=>{const url=String(u);
                    if(url==='/api/operator-asks')return json(window.__asks);
                    if(url==='/api/board/release/messages'&&o.method==='POST')return answer();
                    if(url.endsWith('/asks/41/buttons/2/claim'))return answer();
                    if(url.endsWith('/close')){window.__closed++;return json({error:'already answered'},409);}
                    return orig(u,o);
                };
                window.switchNavTab('hub-inbox');await window.__m.refreshOperatorAsks(true);return true;
            })()`);
            assert.equal(await ev(`window.__m.operatorAsks().length`),3,'linked words merge, different key/team stay separate');
            assert.match(await ev(`window.__m.askFull(window.__m.operatorAsks()[0])`),/Also asked by QA/,'source visible');
            assert.equal(await ev(`window.__m.replyToAsk(window.__m.operatorAsks()[0],'No').then(()=>false,()=>true)`),true,'refused answer reported');
            assert.equal(await ev(`window.__asks.length`),4,'failed answer preserves every source');
            await ev(`window.__fail=false;window.__m.replyToAsk(window.__m.operatorAsks()[0],'No').then(()=>window.__m.refreshOperatorAsks(true)).then(()=>true)`);
            assert.equal(await ev(`window.__m.operatorAsks().length`),2,'one answer removes both linked asks');
            assert.equal(await ev(`window.__closed`),0,'backend-linked asks get no redundant closes');
            await ev(`window.__asks=structuredClone(window.__seed);window.__m.refreshOperatorAsks(true).then(()=>window.__m.openAskDialog(window.__m.operatorAsks()[0])).then(()=>true)`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog [data-button-id="2"]')`,'stored No reply choice',8000);
            await ev(`document.querySelector('dialog.inbox-ask-dialog [data-button-id="2"]').click();true`);
            await waitFor(`window.__answers===2&&!document.querySelector('dialog.inbox-ask-dialog[open]')`,'reply-button success',8000);
            assert.equal(await ev(`window.__closed`),0,'reply-button path also leaves linked propagation to server');
            await ev(`window.__asks=structuredClone(window.__seed);window.__m.refreshOperatorAsks(true).then(()=>true)`);
            await ev(`window.__asks=window.__asks.filter(x=>x.board!=='release');window.__m.refreshOperatorAsks(true).then(()=>true)`);
            assert.equal(await ev(`window.__m.operatorAsks().length`),1,'goal retirement returned by server removes linked and unrelated asks on that goal');
        }
        console.log('PASS shared ask keys merge different wording and preserve authoritative outcomes');
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
