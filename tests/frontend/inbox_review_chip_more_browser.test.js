// #16619: review counts are lower bounds until all matching pages are loaded, including a filtered window.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'qa-review-chip-more';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const chips = `Object.fromEntries([...document.querySelectorAll('#group-table-view button.goals-chip')].map(b=>{const s=b.textContent.trim();return [s.replace(/ [0-9]+\\+?$/,''),s];}))`;
    const expect = async (n, label) => {
        await waitFor(`(${chips})['All'] === 'All ${n}' && (${chips})['For review'] === 'For review ${n}'`,label,8000,chips);
        assert.equal(await ev(`(${chips})['Question']`),'Question 0','exact non-review counts have no plus');
    };
    const search = async q => {
        await ev(`(() => {const s=document.querySelector('#inbox-needs-search');s.value=${JSON.stringify(q)};s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for(const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${BOARD}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer'})}).then(r=>{if(!r.ok)throw new Error('subscribe '+r.status);})`);
            await ev(`(() => {const inner=window.fetch; window.__reviewItems=Array.from({length:3},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:i===2?'Plan Only.md':'Plan '+(i+1)+'.md',media_type:'text/markdown',created_at:new Date(Date.now()-i*60000).toISOString(),source:'upload',available:true,produced_by:'Writer',session_id:'writer',tags:['for review'],uri:'coral://artifacts/'+(i+1).toString(16).padStart(64,'0')}));
                window.fetch=(u,o={})=>{const url=new URL(String(u && u.url || u),location.href);
                    if(url.pathname==='/api/team-artifacts'){url.searchParams.set('limit',String(Math.min(2,Number(url.searchParams.get('limit')||50))));const page=window.__reviewFixturePage(url,location.href,{'${BOARD}':window.__reviewItems});return Promise.resolve(Response.json(page));}
                    if(url.pathname==='/api/operator-asks')return Promise.resolve(Response.json([]));
                    return inner(u,o);};
                localStorage.removeItem('coral-inbox-needs-filters'); T.state.liveSessions=[];T.state.servers=[];T.state.settings.inbox_welcome='off'; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>import((window.__coralStatic||'/static/')+'inbox_reviews.js')).then(m=>m.refreshReviews(true)).then(()=>true)`);
            await expect('2+',width+' first page is a lower bound');
            await search('Only');
            await expect('1',width+' complete filtered result stays exact despite unfinished global pages');
            await search('');
            await expect('2+',width+' unfiltered count remains partial');
            await waitFor(`!!document.querySelector('#group-table-view [data-review-more]')`,'unfiltered Show more',5000);
            await ev(`document.querySelector('#group-table-view [data-review-more]').click();true`);
            await expect('3',width+' final global page removes plus');
            await search('Plan');
            await expect('2+',width+' filtered pages use their own lower bound despite complete global pages');
            await waitFor(`!!document.querySelector('#group-table-view .inbox-more-files button')`,'filtered Show more',5000);
            await ev(`document.querySelector('#group-table-view .inbox-more-files button').click();true`);
            await expect('3',width+' final filtered page removes plus');
        }
        console.log('PASS review and All chips distinguish partial and complete pages, globally and under search');
    } finally { await removeBoards(ev,[BOARD]).catch(()=>{}); await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
