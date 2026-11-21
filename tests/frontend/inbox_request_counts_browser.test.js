// #20397: count actual underlying fetch calls (below the startup share wrapper)
// with deterministic artifact/status fixtures. No live user data or timing SLA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { BASE } = require('./test_base');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { waitStable } = require('./helpers/wait').bind(ev);
    const failures=[], evidence=[];
    const check=(ok,label,data)=>{evidence.push({label,ok,data});console.log(`${ok?'PASS':'FAIL'} ${label}: ${JSON.stringify(data)}`);if(!ok)failures.push(label);};
    const spy=`(() => {
        window.__coralNoFetchShare=false; window.__wire=[]; window.__wireOpen=0;
        const real=window.fetch; window.fetch=(u,o={})=>{
            const p=new URL(String(u),location.href), method=(o.method||'GET').toUpperCase();
            if(!p.pathname.startsWith('/api/'))return real(u,o);
            const q=new URLSearchParams(p.search);q.sort();window.__wire.push({method,path:p.pathname,query:q.toString()});window.__wireOpen++;
            let result;
            if(p.pathname.endsWith('/api/team-artifacts')) result=new Promise((resolve,reject)=>{
                const status=window.__artifactStatus||200, bad=window.__artifactBad;
                const abort=()=>{clearTimeout(timer);reject(o.signal.reason||new DOMException('Canceled','AbortError'));};
                const timer=setTimeout(()=>{o.signal?.removeEventListener('abort',abort);resolve(Response.json(status===403?{code:'owner_only'}:bad?{}:{artifacts:[],teams:[],all:0,total:0,tag_counts:{},has_more:false,versions:'newest'},{status}));},80); // sleep-ok: deterministic server latency exposes overlapping reads
                if(o.signal?.aborted)abort();else o.signal?.addEventListener('abort',abort,{once:true});
            });
            else if(/^\\/api\\/board\\/[^/]+\\/status$/.test(p.pathname))result=Promise.resolve(Response.json({agents:[],artifacts_rev:1,artifacts_all_rev:1}));
            else result=real(u,o);
            return result.finally(()=>window.__wireOpen--);
        };
    })();`;
    const settled=async()=>{await waitFor(`window.__wireOpen===0`,'all fixture API reads settled',10000);await waitStable(`window.__wire.length`,'request count stable',250,{timeout:10000});};
    const reads=path=>ev(`window.__wire.filter(r=>r.method==='GET'&&r.path===${JSON.stringify(path)})`);
    const probeReads=()=>ev(`window.__wire.filter(r=>r.path==='/api/team-artifacts'&&new URLSearchParams(r.query).get('tag')==='perf-probe')`);
    try {
        await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD+spy});
        for(const width of [1280,390]){
            await Emulation.setDeviceMetricsOverride({width,height:844,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await settled();
            check((await reads('/api/settings')).length<=1,`${width} startup settings shared`,await reads('/api/settings'));
            check((await reads('/api/system/auth-status')).length<=1,`${width} startup auth status shared`,await reads('/api/system/auth-status'));
            const cold=await reads('/api/team-artifacts'), coldCounts={};for(const r of cold){const key=r.path+'?'+r.query;coldCounts[key]=(coldCounts[key]||0)+1;}
            check(Object.values(coldCounts).every(n=>n<=1),`${width} startup artifact badges share identical queries`,coldCounts);
            await ev(`window.switchNavTab('hub-inbox'); true`);await settled();
            check(!(await ev(`performance.getEntriesByType('resource').some(r=>new URL(r.name).pathname.endsWith('/inbox_activity.js'))`)),`${width} Activity module deferred until its folder opens`,null);
            for(const folder of ['tasks','activity','artifacts','chats','needs']){
                await ev(`window.__wire=[]; import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.showInbox({folder:${JSON.stringify(folder)}})).then(()=>true)`);await settled();
                const wire=await ev(`window.__wire`), counts={};for(const r of wire)if(r.method==='GET'&&r.path==='/api/team-artifacts'){const key=r.path+'?'+r.query;counts[key]=(counts[key]||0)+1;}
                check(Object.values(counts).every(n=>n<=1),`${width} ${folder}: no duplicate artifact query`,counts);
                check((await reads('/api/settings')).length===0,`${width} ${folder}: no settings reload`,await reads('/api/settings'));
                if(folder!=='needs')check((await reads('/api/goals')).length===0,`${width} ${folder}: no hidden goals read`,await reads('/api/goals'));
            }
            // Same public reader, different query object order: one in flight and
            // a warm answer. A revision/write invalidates that answer immediately.
            await ev(`window.__wire=[]; (async()=>{const m=await import((window.__coralStatic||'/static/')+'query_skew.js');const query={tag:'perf-probe',versions:'newest',limit:'7'};await Promise.all([m.fetchSkewed('local','/api/team-artifacts',query),m.fetchSkewed('local','/api/team-artifacts',{limit:'7',versions:'newest',tag:'perf-probe'})]);await m.fetchSkewed('local','/api/team-artifacts',query);})().then(()=>true)`);
            check((await probeReads()).length===1,`${width} canonical query in-flight and warm share`,await reads('/api/team-artifacts'));
            await ev(`(async()=>{const feed=await import((window.__coralStatic||'/static/')+'artifacts_feed.js');feed.invalidateArtifacts('release');const m=await import((window.__coralStatic||'/static/')+'query_skew.js');await m.fetchSkewed('local','/api/team-artifacts',{tag:'perf-probe',versions:'newest',limit:'7'});})().then(()=>true)`);
            check((await probeReads()).length===2,`${width} artifact write invalidates warm share`,await reads('/api/team-artifacts'));
            await ev(`window.__wire=[]; (async()=>{const m=await import((window.__coralStatic||'/static/')+'query_skew.js');window.__cancel=new AbortController();const q={tag:'abort-probe',limit:'9'};window.__cancelResult=Promise.all([m.fetchSkewed('local','/api/team-artifacts',q,{signal:window.__cancel.signal}).then(()=> 'answered',e=>e.name),m.fetchSkewed('local','/api/team-artifacts',q).then(r=>r.response.status)]);})().then(()=>true)`);
            await waitFor(`window.__wire.some(r=>r.query.includes('abort-probe'))`,'shared transport started before cancellation');
            const canceled=await ev(`window.__cancel.abort(); window.__cancelResult`);
            const abortedReads=await ev(`window.__wire.filter(r=>r.query.includes('abort-probe'))`);
            check(canceled[0]==='AbortError'&&canceled[1]===200&&abortedReads.length===1,`${width} cancel one caller keeps the other read alive`,{canceled,reads:abortedReads.length});
            for(const flag of ['__artifactStatus','__artifactBad']){
                await ev(`window.__wire=[];(async()=>{const m=await import((window.__coralStatic||'/static/')+'query_skew.js'),q={tag:'error-probe-${flag}',limit:'11'};window.${flag}=${flag==='__artifactStatus'?'403':'true'};await m.fetchSkewed('local','/api/team-artifacts',q);await m.fetchSkewed('local','/api/team-artifacts',q);window.${flag}=${flag==='__artifactStatus'?'200':'false'};await m.fetchSkewed('local','/api/team-artifacts',q);})().then(()=>true)`);
                const n=await ev(`window.__wire.filter(r=>r.query.includes('error-probe-')).length`);
                check(n===3,`${width} ${flag}: refusals/malformed JSON never cached`,n);
            }
            await ev(`window.__wire=[];(async()=>{const m=await import((window.__coralStatic||'/static/')+'query_skew.js'),q={tag:'ttl-probe',limit:'13'};await m.fetchSkewed('local','/api/team-artifacts',q);const now=Date.now;try{Date.now=()=>now()+6000;await m.fetchSkewed('local','/api/team-artifacts',q);}finally{Date.now=now;}})().then(()=>true)`);
            check((await ev(`window.__wire.filter(r=>r.query.includes('ttl-probe')).length`))===2,`${width} short TTL expires`,null);
            await ev(`window.__wire=[];(async()=>{const m=await import((window.__coralStatic||'/static/')+'query_skew.js'),q={tag:'fresh-probe',limit:'15'};await m.fetchSkewed('local','/api/team-artifacts',q);await m.fetchSkewed('local','/api/team-artifacts',q,{cache:'reload'});await m.fetchSkewed('local','/api/team-artifacts',q);})().then(()=>true)`);
            check((await ev(`window.__wire.filter(r=>r.query.includes('fresh-probe')).length`))===3,`${width} explicit freshness forgets older cached data`,null);
            await ev(`window.__wire=[];(async()=>{const m=await import((window.__coralStatic||'/static/')+'auth_status_read.js');await Promise.all([m.readAuthStatus({fresh:true}),m.readAuthStatus()]);document.dispatchEvent(new CustomEvent('coral:password-changed'));await m.readAuthStatus();})().then(()=>true)`);await settled();
            check((await reads('/api/system/auth-status')).length===2,`${width} password change invalidates shared auth read`,await reads('/api/system/auth-status'));
        }
    } finally {if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/request-counts.json',JSON.stringify(evidence,null,2));}await client.close();}
    assert.deepEqual(failures,[],'duplicate and unneeded Inbox reads');
})().catch(e=>{console.error(e);process.exit(1);});
