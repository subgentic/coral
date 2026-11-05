// #13125/#13117: the Hub transport permits only read-bit changes. Exercise the
// existing shell writers against that rule; tag editors remain read-only.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const HEX = n => String(n).repeat(64);
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const write = (hex, read) => ev(`import(${S}+'inbox_reviews.js').then(async m=>{const row=m.reviewItems().find(r=>r.hex==='${hex}');if(!row)throw Error('Missing fixture row');await m.setReviewRead(row,${read});return true;})`);
    const stored = () => ev(`window.__files.map(a=>a.tags)`);
    try {
        await setupHubWorld({client,Page,Emulation,width:1440,height:900,mobile:false,inbox:false});
        await Page.addScriptToEvaluateOnNewDocument({source:`(() => {
            const real=window.fetch, json=(b,status=200)=>Promise.resolve(new Response(JSON.stringify(b),{status,headers:{'content-type':'application/json'}}));
            window.__puts=[]; window.__rejects=[];window.__requests=[];window.__decisions=[];
            window.__files=[1,2].map(n=>({id:String(n).repeat(64),uri:'coral://artifacts/'+String(n).repeat(64),name:'plan-'+n+'.md',media_type:'text/markdown',source:'upload',available:true,size:32,produced_by:'Writer '+n,session_id:'writer-'+n,created_at:'2026-11-04T00:00:00Z',tags:['for review','internal','draft','final']}));
            window.fetch=(u,o={})=>{
                const url=new URL(String(u),location.href), p=url.pathname;window.__requests.push(p+url.search);
                const review=/^\\/api\\/remote\\/m1\\/api\\/board\\/same-team\\/artifacts\\/([a-f0-9]{64})\\/review$/.exec(p);
                if(review && o.method==='POST') {
                    const a=window.__files.find(a=>a.id===review[1]), {decision,quiet}=JSON.parse(o.body);
                    window.__decisions.push({id:a.id,decision,...(quiet?{quiet:true}:{})});
                    if(decision==='ignore' && quiet)a.tags=[...a.tags.filter(t=>!['for review','read','changes requested','saved','ignored'].includes(t)),'superseded'];
                    else if(decision==='ignore')a.tags=[...a.tags.filter(t=>t!=='for review' && t!=='ignored'),'ignored'];
                    else a.tags=[...a.tags.filter(t=>t!=='for review'),decision==='approve'?'approved':'denied'];
                    return json({tags:a.tags,review:{state:decision==='approve'?'approved':'denied'},delivered:false,reason:'no_uploader'});
                }
                const m=/^\\/api\\/remote\\/(m[12])\\/api\\/board\\/same-team\\/artifacts(?:\\/([a-f0-9]{64})\\/tags)?$/.exec(p);
                if(m && (o.method||'GET')==='PUT') {
                    const a=window.__files.find(a=>a.id===m[2]), tags=JSON.parse(o.body).tags;
                    const rest=ts=>[...new Set(ts.filter(t=>t!=='read'))].sort().join('|');
                    if(!a || rest(tags)!==rest(a.tags)) {window.__rejects.push({path:p,tags});return json({error:'Hub tags may only change read'},400);}
                    a.tags=[...tags];window.__puts.push({path:p,tags:[...tags]});return json({tags:a.tags});
                }
                if(p==='/api/board/same-team/artifacts')return json({project:'same-team',artifacts:window.__files,has_more:false,total:2,tag_counts:{'for review':2,internal:2}});
                if(m) {const tag=url.searchParams.get('tag');const rows=m[1]==='m1'?window.__files.filter(a=>!tag||a.tags.includes(tag)):[];return json({project:'same-team',artifacts:rows,has_more:false,total:rows.length,tag_counts:{'for review':2,internal:2}});}
                if(/\\/api\\/artifacts\\/[a-f0-9]{64}\\/comments/.test(p))return json({comments:[],you:{kind:'owner',can_comment:true},locked:false});
                if(/\\/api\\/artifacts\\/[a-f0-9]{64}\\/versions/.test(p))return json([]);
                if(/\\/api\\/artifacts\\/[a-f0-9]{64}$/.test(p))return Promise.resolve(new Response('# Review plan',{headers:{'content-type':'text/markdown'}}));
                return real(u,o);
            };
        })()`});
        await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','liveList','settings');
        assert.equal(await ev(`import(${S}+'server_base.js').then(m=>m.isCloud())`),true,'actual cloud boot, not a simulated local writer');
        await ev(`import(${S}+'inbox_reviews.js').then(m=>m.refreshReviews(true)).then(()=>true)`);
        assert.equal(await ev(`import(${S}+'inbox_reviews.js').then(m=>m.reviewItems().length)`),2);
        // The row copy is stale: a newly stored fifth tag must survive read/unread.
        await ev(`window.__files[0].tags.push('new tag');true`);
        await write(HEX(1),true);
        assert.deepEqual((await stored())[0],['for review','internal','draft','final','new tag','read'],'read changes only read, including above the five-tag cap');
        await write(HEX(1),false);
        assert.deepEqual((await stored())[0],['for review','internal','draft','final','new tag'],'unread preserves all non-read tags');
        await ev(`import(${S}+'inbox_reviews.js').then(m=>m.markOpenedRead('${HEX(1)}')).then(()=>true)`);
        assert.ok((await stored())[0].includes('read'),'markOpenedRead succeeds under the strict Hub rule');
        await write(HEX(1),false);
        const before = await ev(`window.__puts.length`);
        await ev(`import(${S}+'artifact_viewer.js').then(m=>m.openArtifactViewer('${HEX(1)}',{server:'m1',board:'same-team',filename:'plan-1.md',mediaType:'text/markdown'})).then(()=>true)`);
        await waitFor(`window.__files[0].tags.includes('read')`,'opening the viewer marks the file read');
        assert.equal(await ev(`window.__puts.length`),before+1,'viewer and preview renderer share the in-flight mark');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click();true`);
        await write(HEX(1),false);
        await Emulation.setDeviceMetricsOverride({width:390,height:900,deviceScaleFactor:1,mobile:true});
        await Emulation.setTouchEmulationEnabled({enabled:true});
        // The current Hub pin frames Needs you on its own server. Exercise the
        // shell's bulk writer through the pre-native folder export, still with
        // an actual cloud boot and strict Hub transport.
        await ev(`import(${S}+'inbox_sidebar.js').then(m=>m.showInbox({folder:'needs'})).then(()=>true)`);
        await ev(`import(${S}+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length>=2`,'Needs you files');
        const bulk = async label => {
            for(const n of [1,2]) await ev(`(() => {const row=[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].find(r=>r.textContent.includes('plan-${n}.md'));const c=row.querySelector('[role=checkbox],input[type=checkbox]');if(!(c.checked||c.getAttribute('aria-checked')==='true'))c.click();return true;})()`);
            await waitFor(`!!document.querySelector('.dt-bar .dt-bar-more-toggle')`,'bulk More actions');
            await ev(`document.querySelector('.dt-bar .dt-bar-more-toggle').click();true`);
            await waitFor(`[...document.querySelectorAll('.dt-bar .menu-item')].some(b=>b.textContent==='${label}'&&!b.disabled)`,'enabled '+label);
            await ev(`[...document.querySelectorAll('.dt-bar .menu-item')].find(b=>b.textContent==='${label}').click();true`);
            await waitFor(`window.__files.every(a=>${label==='Mark read'?'':'!'}a.tags.includes('read'))`,'both files '+label);
        };
        await bulk('Mark read');await bulk('Mark unread');
        // Approve and Deny settle an earlier version quietly via the decision
        // route; the read-only tags route must never be used for this mutation.
        for (const decision of ['approve','deny']) {
            await ev(`(() => {const base=window.__files.find(a=>a.id==='${HEX(2)}');base.tags=['for review','internal','draft','final'];window.__files=window.__files.filter(a=>a.id!=='${HEX(3)}');window.__files.push({...base,id:'${HEX(3)}',uri:'coral://artifacts/${HEX(3)}',tags:[...base.tags],created_at:'2026-11-03T00:00:00Z'});window.__decisions=[];return true;})()`);
            const result=await ev(`(async()=>{const m=await import(${S}+'inbox_reviews.js');await m.refreshReviews(true);const row=m.reviewItems().find(a=>a.hex==='${HEX(2)}');const r=await import(${S}+'artifact_review.js');const out=await r.${decision==='approve'?'approveRow':'denyRow'}(row.team,row${decision==='deny' ? ", 'Does not meet the requirements'" : ''});await m.refreshReviews(true);return {earlier:out.earlier,oldStillNeeded:m.reviewItems().some(a=>a.hex==='${HEX(3)}')};})()`);
            assert.deepEqual(result.earlier,{settled:1,failed:0},decision+': earlier version settles under the strict Hub rule');
            assert.equal(result.oldStillNeeded,false,decision+': earlier version stays out after a fresh read');
            assert.deepEqual(await ev(`window.__decisions`),[{id:HEX(2),decision},{id:HEX(3),decision:'ignore',quiet:true}],decision+': old version is automatically superseded, no Operator dismissal or extra verdict');
            assert.equal(await ev(`window.__files.find(a=>a.id==='${HEX(3)}').tags.includes('superseded') && !window.__files.find(a=>a.id==='${HEX(3)}').tags.includes('ignored')`),true,decision+': automatic settlement stays out of Dismissed');
            assert.deepEqual(await ev(`window.__rejects`),[],decision+': no forbidden tags PUT');
        }
        // The shared writer is guarded even if a future caller forgets to hide
        // its editor; both editor and bulkTag entry points get a Hub case.
        await ev(`import(${S}+'artifact_tags.js').then(m=>{const node=m.tagEditor({project:'same-team',hex:'${HEX(1)}',tags:['for review'],editable:true});node.id='hub-tag-editor-probe';document.body.append(node);return true;})`);
        assert.equal(await ev(`[...document.querySelectorAll('#hub-tag-editor-probe button')].filter(b=>b.getClientRects().length&&!b.disabled).length`),0,'shared editor enforces read-only under the Hub even with editable requested');
        const attempts=await ev(`window.__requests.filter(p=>p.endsWith('/tags')).length`);
        const tagResult=await ev(`import(${S}+'artifact_tags.js').then(m=>m.bulkTag('@m1/same-team',[{hex:'${HEX(1)}',tags:['for review']}],'another tag',true)).then(r=>({ok:r.ok.size,failed:r.failed}))`);
        assert.deepEqual(tagResult,{ok:0,failed:1},'shared bulk writer refuses a non-read Hub tag change');
        assert.equal(await ev(`window.__requests.filter(p=>p.endsWith('/tags')).length`),attempts,'refused tag edit never reaches the Hub transport');
        await ev(`document.getElementById('hub-tag-editor-probe').remove();window.__files=window.__files.filter(a=>a.id!=='${HEX(3)}');for(const a of window.__files)a.tags=['for review','internal','draft','final'];true`);
        await Emulation.setDeviceMetricsOverride({width:1440,height:900,deviceScaleFactor:1,mobile:false});
        await Emulation.setTouchEmulationEnabled({enabled:false});
        // A local-server team key makes !isCloud() the decisive editor guard,
        // rather than accidentally passing only because the server is remote.
        await ev(`window.openTeamPage('same-team',{tab:'artifacts'});true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length>=2`,'team artifact rows',5000,`({requests:window.__requests.slice(-25),team:document.querySelector('#team-panel-artifacts')?.textContent.slice(-1800),ids:[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].map(e=>({tag:e.tagName,cls:e.className,text:e.textContent})),panels:[...document.querySelectorAll('[id*=artifacts]')].map(e=>({id:e.id,hidden:e.hidden,html:e.innerHTML.slice(0,400)}))})`);
        await ev(`document.querySelector('#team-panel-artifacts [data-artifact-id]').click();true`);
        await waitFor(`!!document.querySelector('.detail-head .artifact-tag-list')`,'read-only tag chips');
        assert.equal(await ev(`[...document.querySelectorAll('.detail-head .artifact-tag-add, .detail-head .artifact-tag-remove')].filter(b=>b.getClientRects().length).length`),0,'Hub file sheet has no tag editor controls');
        await ev(`document.querySelector('#team-panel-artifacts tbody input[type=checkbox]').click();true`);
        await waitFor(`!!document.querySelector('#team-panel-artifacts .dt-bar-count')`,'artifact selection bar');
        assert.equal(await ev(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar button')].some(b=>/^(Tag|Untag)$/.test(b.textContent))`),false,'Hub bulk tag editor is unavailable');
        assert.deepEqual(await ev(`window.__rejects`),[],'every write obeyed the server rule');
        assert.ok((await stored()).every(tags=>tags.includes('for review')&&tags.includes('internal')),'all read paths preserve non-read tags');
        console.log('PASS Hub read tags: explicit read/unread, markOpenedRead, viewer open, bulk read/unread, read-only sheet/bulk editor');
        console.log(JSON.stringify(await ev(`window.__puts`)));
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
