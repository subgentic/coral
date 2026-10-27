// #8144: failed-run reasons and long registered-server names at desktop and phone widths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { swapTheme } = require('./helpers/theme');
const BASE = require('./test_base').BASE;
const REASON = 'git worktree add failed: the destination /work/builds/release-candidate-for-the-next-long-running-deployment already exists and is not an empty directory. Remove the stale checkout before retrying this scheduled build.';
const NAME = 'Production build server for the release candidate integration and packaging team in the west region';
(async () => {
    const {client, Page, Emulation, ev, waitFor, PRELOAD, install} = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d=process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/out/shots-8144` : ''); if (!d) return; fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(`${d}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        // Supply a consistent hub from the first health/live reads, including later refreshes.
        await Page.addScriptToEvaluateOnNewDocument({source:`(() => {
            const real=window.fetch, servers=[{id:'build-west',label:${JSON.stringify(NAME)},status:'online',url:'https://build.example.com',agents:4}];
            const J=o=>Promise.resolve(new Response(JSON.stringify(o),{headers:{'Content-Type':'application/json'}}));
            window.fetch=(u,o)=>{const p=new URL(String(u),location.origin).pathname;
                if(p==='/api/health')return J({status:'ok',hub:true});
                if(p==='/api/sessions/live')return J({sessions:[],servers});
                if(p==='/api/servers')return J(servers);
                return real(u,o);};
        })()`});
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Emulation.setTouchEmulationEnabled({enabled:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(async()=>{ const real=window.fetch; const J=o=>Promise.resolve(new Response(JSON.stringify(o),{headers:{'Content-Type':'application/json'}}));
                const run={id:1,status:'failed',error_msg:${JSON.stringify(REASON)},started_at:'2026-10-25T12:00:00Z',finished_at:'2026-10-25T12:01:00Z'};
                const job={id:1,name:'Release packaging',job_type:'prompt',agent_type:'claude',enabled:1,cron_expr:'0 2 * * *',timezone:'UTC',repo_path:'/work/repo',prompt:'Build the release',max_duration_s:3600,last_run:run};
                const servers=[{id:'build-west',label:${JSON.stringify(NAME)},status:'online',url:'https://build.example.com',agents:4}];
                window.fetch=(u,o)=>{const p=new URL(String(u),location.origin).pathname;
                    if(p==='/api/scheduled/jobs')return J({jobs:[job]}); if(p==='/api/scheduled/jobs/1/runs')return J({runs:[run],total:1});
                    if(p==='/api/workflows')return J({workflows:[]}); if(p==='/api/servers')return J(servers); return real(u,o);};
                const {state}=await import(${S}+'state.js'); state.hub=true; state.servers=servers; (await import(${S}+'servers_tab.js')).updateServersTabVisibility(); return true;
            })()`);
            for (const theme of ['dark','light']) {
                await swapTheme(ev,theme);
                await ev(`window.switchNavTab('automations'); import(${S}+'scheduler.js').then(async m=>{await m.refreshJobs(); await m.selectScheduledJob(1);return true;})`);
                await waitFor(`!!document.querySelector('#sched-run-history .dt-clamp-2')`, 'the reason below Failed');
                const reason=await ev(`(()=>{const chip=document.querySelector('#sched-run-history .sched-status'),r=document.querySelector('#sched-run-history .dt-clamp-2'),s=getComputedStyle(r);return {chip:chip.textContent,text:r.textContent,title:r.title,size:s.fontSize,weight:s.fontWeight,color:s.color,secondary:getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim(),clamp:s.webkitLineClamp,normal:s.whiteSpace,below:r.getBoundingClientRect().top>=chip.getBoundingClientRect().bottom-1,over:document.documentElement.scrollWidth-innerWidth};})()`);
                assert.equal(reason.chip,'Failed'); assert.equal(reason.text,REASON); assert.equal(reason.title,REASON);
                assert.equal(reason.size,'12px'); assert.equal(reason.weight,'400'); assert.equal(reason.clamp,'2'); assert.equal(reason.normal,'normal'); assert.ok(reason.below && reason.over<=1,JSON.stringify(reason));
                await shot(`jobs-long-reason-${width}-${theme}`);
                await ev(`window.switchNavTab('servers'); true`);
                await waitFor(`!!document.querySelector('#server-row-build-west .dt-name-text')`, 'long server name', 10000, `({tab:document.querySelector('.nav-tab.active')?.id,body:document.querySelector('#servers-tab-body')?.textContent,servers:window.__qaState?.servers})`);
                const name=await ev(`(()=>{const n=document.querySelector('#server-row-build-west .dt-name-text'),b=n.closest('button'),s=getComputedStyle(n),td=n.closest('td');return {text:n.textContent,title:td.title,buttonTitle:b.title,accessible:b.getAttribute('aria-label'),space:s.whiteSpace,clamp:s.webkitLineClamp,folded:!!n.closest('.dt-folded'),nameHeight:n.getBoundingClientRect().height,height:b.getBoundingClientRect().height,width:b.getBoundingClientRect().width,clipped:n.scrollWidth>n.clientWidth,over:document.documentElement.scrollWidth-innerWidth};})()`);
                assert.equal(name.text,NAME); assert.equal(name.title,NAME); assert.equal(name.buttonTitle,NAME); assert.equal(name.accessible,'Open '+NAME); assert.ok(name.over<=1,JSON.stringify(name));
                if(width===390){assert.equal(name.folded,true);assert.equal(name.space,'normal');assert.equal(name.clamp,'2');assert.ok(name.nameHeight<60,JSON.stringify(name));assert.ok(name.height>=44 && name.width>=44,JSON.stringify(name));}
                else {assert.equal(name.space,'nowrap');assert.equal(name.clipped,true,'desktop name is ellipsized');}
                await shot(`servers-long-name-${width}-${theme}`);
                console.log(`PASS ${width} ${theme}: short failed chip, two-line reason, complete title, responsive server name`);
            }
        }
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
