// #17691: identical asks share one row; answering retires sources only after success.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => {
                window.__m = await import((window.__coralStatic || '/static/') + 'operator_asks.js');
                const a = { board: 'team', kind: 'ask', id: 41, asker: 'Lead', text: '@Operator Ship this version?', goal_id: 2, at: '2026-11-15T01:00:00Z' };
                window.__asks = [a, {...a,id:42,asker:'QA',text:'@Operator  Ship this version? '}, {...a,id:43,text:'@Operator Ship another version?'}, {...a,id:44,goal_id:3}, {...a,id:45,buttons:[{id:1,label:'Yes',action:'reply',state:'pending'}]}];
                window.__closed=[]; window.__fail=true; window.__closeFail=false;
                const orig=window.fetch.bind(window), json=(x,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}}));
                window.fetch=(u,o={})=>{ const url=String(u);
                    if(url==='/api/operator-asks')return json(window.__asks);
                    if(url==='/api/board/team/messages' && o.method==='POST'){
                        if(window.__fail)return json({error:'retry later'},429);
                        const b=JSON.parse(o.body);window.__asks=window.__asks.filter(x=>x.id!==b.reply_to);return json({id:99});
                    }
                    if(url.endsWith('/asks/42/close')){
                        window.__closed.push(JSON.parse(o.body));if(window.__closeFail)return json({error:'close failed'},503);
                        window.__asks=window.__asks.filter(x=>x.id!==42);return json({ok:true});
                    }
                    return orig(u,o);
                };
                window.switchNavTab('hub-inbox'); await window.__m.refreshOperatorAsks(true);return true;
            })()`);
            await waitFor(`document.querySelector('#group-table-view tbody tr')`, 'question rows', 8000);
            if (process.env.CORAL_DUPLICATE_SHOTS) {
                const shot = await Page.captureScreenshot({ format: 'png' });
                fs.mkdirSync(process.env.CORAL_DUPLICATE_SHOTS, { recursive: true });
                fs.writeFileSync(`${process.env.CORAL_DUPLICATE_SHOTS}/${width}.png`, Buffer.from(shot.data, 'base64'));
            }
            assert.equal(await ev(`window.__m.operatorAsks().length`),4,'exact duplicate merged; different words/subject/buttons remain');
            assert.equal(await ev(`window.__m.operatorAsks()[0].duplicates[0].asker`),'QA','source retained');
            assert.match(await ev(`window.__m.askFull(window.__m.operatorAsks()[0])`),/QA/,'row names other asker');
            assert.equal(await ev(`window.__m.replyToAsk(window.__m.operatorAsks()[0],'No').then(()=>false,()=>true)`),true,'failed reply reported');
            assert.equal(await ev(`window.__closed.length`),0,'failed answer closes no duplicate');
            assert.equal(await ev(`window.__asks.length`),5,'failed answer preserves all source asks');
            await ev(`window.__fail=false;window.__closeFail=true;window.__m.replyToAsk(window.__m.operatorAsks()[0],'No').then(()=>true)`);
            assert.equal(await ev(`window.__asks.some(x=>x.id===42)`),true,'failed close retains duplicate');
            assert.equal(await ev(`window.__closed[0].note`),'Same question answered on message #41','closure records answer, never sends approval');
            await ev(`window.__closeFail=false;window.__asks.unshift({...window.__asks.find(x=>x.id===42),id:41,asker:'Lead'});window.__m.refreshOperatorAsks(true).then(()=>true)`);
            await ev(`window.__m.replyToAsk(window.__m.operatorAsks()[0],'No').then(()=>true)`);
            assert.deepEqual(await ev(`window.__asks.map(x=>x.id)`),[43,44,45],'successful answer closes matching source only');
        }
        console.log('PASS exact duplicate asks merge and close only after a successful answer');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
