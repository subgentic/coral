'use strict';
// The stubbed two-computer Coral Hub the dashboard is served as (hub_history_board_nav_browser's): cloud mode under the hub's CSP, two computers (Laptop, Desktop) with a chat, a board and their pages. Shared by the
// Hub's keyboard and announcements censuses (#6226). window.__computers is the computer list /api/servers answers (change .online to change a status) and window.__extraBoard appends messages to the board.
const { safePaused } = require('./paused');
const BASE = require('../test_base').BASE;
const HOST = new URL(BASE).host;
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "font-src 'self'", "img-src 'self' data: blob:", `connect-src 'self' ws://${HOST}`, "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');

/** Set the page up as the Hub's before the first navigation: the viewport, the cloud boot flag with the hub's CSP, and the stubbed API. */
async function setupHubWorld({ client, Page, Emulation, width, height, mobile, inbox, hubPages }) {
    const { Fetch, Network } = client;
    await Promise.all([Page.enable(), Network.enable()]);
    await Network.setBypassServiceWorker({ bypass: true });
    await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/*`, resourceType: 'Document', requestStage: 'Response' }] });
        safePaused(client, async e => {
            // hubPages: the Hub's own pages the Inbox frames (/inbox/hub/needs, /tasks, /saved) are a stand-in page here (the isolated server has none, and a frame of the dashboard itself would not say what it shows)
            if (hubPages && /^\/inbox\/hub\//.test(new URL(e.request.url).pathname)) {
                const what = new URL(e.request.url).pathname.split('/').pop();
                const page = `<!doctype html><meta charset="utf-8"><title>Coral Hub</title><body style="margin:0;font:16px system-ui;background:#18181c;color:#e8e8ec"><main style="padding:24px"><p style="color:#a0a0aa;margin:0 0 16px;font-size:13px">Stand-in for the Hub's own ${what} page, framed by the Inbox: it starts at its list, with no title of its own (the Inbox page above it has one).</p><div style="border:1px solid #34343c;border-radius:8px;padding:12px 16px;margin-bottom:10px">Review agent on Laptop waits for your answer<br><small style="color:#a0a0aa">4 min ago</small></div><div style="border:1px solid #34343c;border-radius:8px;padding:12px 16px">Pick the release date<br><small style="color:#a0a0aa">Task for you, high</small></div></main>`;
                return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(page).toString('base64') });
            }
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const b = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body).replace('"mode":"local"', '"mode":"cloud"' + ((typeof inbox === 'function' ? inbox() : inbox) ? ',"inbox":"native"' : '')); // inbox: the boot value the Hub sets per release pin (#9100 Goal #100); a function is read at each load
            await Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-(security-policy|length)$/i.test(h.name)).concat([{ name: 'Content-Security-Policy', value: CSP }]), body: Buffer.from(html).toString('base64') });
        });
  await Page.addScriptToEvaluateOnNewDocument({source:`(() => {
   window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push(e.violatedDirective));
   try{localStorage.setItem('coral-group-by-server','true');}catch(e){} // the sidebar groups agents under their computer (#6241)
   const original=window.fetch; window.__remoteRequests=[];
   const computers=window.__computers=[{id:'m1',label:'Laptop',status:'online',online:true,access_mode:'view',local_mode:'launch',effective_mode:'view'},{id:'m2',label:'Desktop',status:'online',online:true,access_mode:'interact',local_mode:'launch',effective_mode:'interact'}];
   const json=x=>Promise.resolve(new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}}));
   window.fetch=(u,o={})=>{
    const p=new URL(String(u),location.href); const m=(o.method||'GET').toUpperCase();
    if(p.pathname==='/auth/session')return json({authenticated:true,email:'tester@example.com',csrf:'test'});
    if(p.pathname==='/api/account')return json({artifacts_tab:true,artifacts_frame:true});
    if(p.pathname==='/api/sessions/live')return json({sessions:window.__noComputers?[]:[['m1','Review agent'],['m1','Docs agent'],['m2','Build agent']].map(([server,name],i)=>({session_id:'hub-agent-'+i,name:'hub-agent-'+i,display_name:name,agent_type:'claude',working_directory:'/tmp/hub-agent-'+i,server,sleeping:false,archived:false,status:'idle'})),servers:window.__noComputers?[]:computers});
    if(p.pathname==='/api/servers')return json({servers:computers});
    if(p.pathname==='/api/settings'&&m==='GET')return json({settings:{}});
    const match=p.pathname.match(/^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/);
    if(!match)return original(u,o);
    const [_,server,path]=match;window.__remoteRequests.push({server,path,method:m,query:p.search});
    if(path==='/api/sessions/history' && server==='m1' && window.__holdHistory) return new Promise(resolve=>{window.__releaseHistory=()=>resolve(new Response(JSON.stringify({sessions:[{session_id:'same-chat',title:'OLD LAPTOP RESULT'}],total:1}),{headers:{'content-type':'application/json'}}));});
    if(path==='/api/sessions/history')return json({sessions:[{session_id:'same-chat',title:server==='m1'?'Laptop conversation':'Desktop conversation',source_type:'claude'},{session_id:'chat-2',title:'Second conversation on '+server,source_type:'claude'},{session_id:'chat-3',title:'Third conversation on '+server,source_type:'codex'}],total:3,page:1,page_size:50});
    if(path==='/api/sessions/history/search'&&/[?&]q=zzz/.test(p.search))return json({status:'complete',results:[]});
    if(path==='/api/sessions/history/search')return json({status:'complete',results:[{session_id:'same-chat',type:'agent',hits:[{role:'user',excerpt:'needle from '+server,locator:{session_id:'same-chat',message_index:0}}]}]});
    if(path==='/api/sessions/history/no-such-chat')return Promise.resolve(new Response('{"error":"not found"}',{status:404,headers:{'content-type':'application/json'}}));
    if(path==='/api/sessions/history/same-chat')return json({agent_type:'claude',messages:[{type:'user',content:'needle from '+server},{type:'assistant',text:'Scoped to this computer.'}],total:2,start:0});
    if(path.endsWith('/notes'))return json({notes_md:'Notes from '+server});
    if(path==='/api/token-usage')return json({totals:{}});
    if(path.includes('/changes'))return Promise.resolve(new Response('Changes from '+server));
    if(path==='/api/tags'||/\\/(tags|events|tasks|agent-notes|files)$/.test(path))return json([]);
    if(path.endsWith('/git'))return json({commits:[]});
    if(path==='/api/goals')return json({goals:[{id:1,board_id:'same-team',board_label:'Release team',title:'Goal from '+server,state:'active',done_when:'Done on '+server,rollup:{done:0,active:0,blocked:0,queued:1,total:1}}]});
    if(path==='/api/team-artifacts'){if(window.__artifactsOwnerOnly)return Promise.resolve(new Response(JSON.stringify({error:'owner_only',code:'owner_only'}),{status:403,headers:{'content-type':'application/json'}}));return json({artifacts:[{id:'art-'+server,name:'report-'+server+'.md',board_id:'same-team',media_type:'text/markdown',size:12,created_at:'2026-10-22T12:00:00Z'}],limit:100,offset:0,has_more:false,truncated:false,total:1,all:1,teams:[{board_id:'same-team',team:'Release team',all:1}]});}
    if(path==='/api/board/projects')return json([{project:'same-team',board_label:'Release team',message_count:1,subscriber_count:1}]);
    if(path.endsWith('/messages/all')){const base=[{id:1,subscriber_id:'Operator',job_title:'Operator',content:'Board message from '+server,created_at:'2026-10-22T12:00:00Z'},{id:2,subscriber_id:'Operator',job_title:'Operator',content:'Second message from '+server,created_at:'2026-10-22T12:00:20Z'},{id:3,subscriber_id:'Operator',job_title:'Operator',content:'Third message from '+server,created_at:'2026-10-22T12:00:40Z'}];const all=base.concat(window.__extraBoard||[]);return json({messages:all,total:all.length,before_count:0});}
    if(path.endsWith('/subscribers'))return json([{subscriber_id:'Operator',job_title:'Owner'}]);
    if(path.endsWith('/paused'))return json({paused:false});
    if(path.endsWith('/sleep-status'))return json({sleeping:false});
    return json({});
   };
  })();`});
}

module.exports = { setupHubWorld, BASE };
