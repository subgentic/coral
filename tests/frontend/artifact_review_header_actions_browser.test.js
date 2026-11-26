// #21777: compact review header, inline delivery errors and accessible comment icons.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const {coralReady, framesJs} = require('./helpers/wait');
const {BASE} = require('./test_base');
const HEX='d'.repeat(64), OTHER='e'.repeat(64);
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {Input}=client, S=`(window.__coralStatic || '/static/')`;
 const shot=require('./helpers/scene_shots')(Page,'review-header-actions');
 const click=async selector=>{
  const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,ok:h===e||e.contains(h)};})()`);
  assert.ok(p.ok,selector+' is reachable');
  await Input.dispatchMouseEvent({type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
  await Input.dispatchMouseEvent({type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});
 };
    const fixture = `(() => {
        const real = fetch;
        window.__reviewRow = { id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'Release plan', media_type: 'text/markdown', available: true, tags: ['for review'], team: 'draft-test', board_id: 'draft-test', produced_by: 'Frontend Dev', version: 2, created_at: new Date().toISOString() }; window.__drafts = []; window.__revision = 0; window.__writes = []; window.__batches = []; window.__unknown = false; window.__refuse = false; window.__seen = {}; window.__published = []; window.__decisions = []; window.__decisionReplay = null; window.__loseDecision = false;
        const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, options = {}) => {
            const url = new URL(String(u), location.href), method = options.method || 'GET';
            if (url.pathname.endsWith('/comment-images')) return json({hex:'f'.repeat(64),name:'review.png',content_type:'image/png'});
            if (url.pathname === '/api/artifacts/' + 'f'.repeat(64)) return Promise.resolve(new Response(Uint8Array.from(atob(window.__png), c => c.charCodeAt(0)), {headers:{'Content-Type':'image/png'}}));
            const body = options.body ? JSON.parse(options.body) : {};
            if (url.pathname.endsWith('/tags') && method === 'PUT') { window.__reviewRow.tags = body.tags; return json({tags:body.tags}); }
            if (url.pathname === '/api/team-artifacts' && window.__reviewRow) return json(window.__reviewFixturePage(u, location.href, { 'draft-test': [{ ...window.__reviewRow, draft_count: window.__drafts.length }] }));
            if (url.pathname.endsWith('/review') && method === 'POST') {
                if (window.__decisionReplay) return json(window.__decisionReplay);
                window.__decisions.push(body); window.__drafts = []; window.__revision++;
                if (window.__loseDecision) { window.__loseDecision = false; window.__decisionReplay = { status: 'sent', request_id: body.send_drafts.request_id, replayed: true }; return Promise.reject(new TypeError('Decision response lost')); }
                return json({ state: body.decision === 'approve' ? 'approved' : 'changes', changed: true, tags: ['approved'], review: { state: body.decision === 'approve' ? 'approved' : 'changes' }, delivered: true, to: 'Builder', drafts_sent: true, batch: { status: window.__batchStatus || 'sent' } });
            }
            if (url.pathname.includes('/review-drafts')) {
                if (method === 'GET' && window.__draftsStatus) return json({ error: 'refused', message: 'refused' }, window.__draftsStatus); // a Hub without the route (404), a person who may not keep drafts (403)
                if (method === 'GET') return json({ drafts: url.pathname.includes('${OTHER}') ? [] : window.__drafts, revision: window.__revision, count: url.pathname.includes('${OTHER}') ? 0 : window.__drafts.length, drafts_supported: true, can_write: window.__writeAllowed !== false, can_send: window.__sendAllowed !== false, reason: window.__reason || '', targets: window.__targets || ['Builder'] });
                window.__writes.push({ url: url.pathname, method, body });
                if (url.pathname.endsWith('/send')) {
                    if (window.__refuse) return json({ code: window.__refuseCode || 'not_delivered', error: window.__refuseWords || 'Agent unavailable. Drafts kept.' }, 409);
                    if (window.__seen[body.request_id]) return json({ ...window.__seen[body.request_id], replayed: true });
                    if (body.revision !== window.__revision) return json({ code: 'stale_revision', error: 'Drafts changed. Reload before sending.' }, 409);
                    window.__batches.push(window.__drafts.map(d => ({ ...d })));
                    window.__published.push(...window.__drafts.map(d => ({ ...d, author: { kind: 'owner', subject: 'Operator' }, created_at: new Date().toISOString(), can: {} })));
                    window.__drafts = []; window.__revision++;
                    const result = { ok: true, status: 'sent', revision: window.__revision, remaining_count: 0 };
                    window.__seen[body.request_id] = result;
                    if (window.__unknown) { window.__unknown = false; return Promise.reject(new TypeError('Connection lost after delivery')); }
                    return json(result);
                }
                if (method === 'POST') { window.__drafts.push({ ...body, id: window.__revision + 1, source: 'owner' }); window.__revision++; return json({ draft: window.__drafts.at(-1), revision: window.__revision, count: window.__drafts.length }, 201); }
                const id = Number(url.pathname.split('/').at(-1));
                if (method === 'PATCH') window.__drafts = window.__drafts.map(d => d.id === id ? { ...d, body: body.body } : d);
                if (method === 'DELETE') window.__drafts = window.__drafts.filter(d => d.id !== id);
                window.__revision++; return json({ ok: true, revision: window.__revision });
            }
            if (url.pathname.includes('/api/artifacts/') && url.pathname.includes('/comments')) {
                if (method !== 'GET') { window.__writes.push({ url: url.pathname, method, body }); return json({ error: 'Published writes forbidden in draft fixture' }, 500); }
                return json({ comments: window.__published, locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true }, limits: { body: 8192 } });
            }
            if (url.pathname === '/api/artifacts/${HEX}' || url.pathname === '/api/artifacts/${OTHER}') return Promise.resolve(new Response('# Release plan\\n\\nVersion 2 · Frontend Dev\\n\\n## Before launch\\n\\nAssign an owner before launch. Confirm that the team can roll back the release.\\n\\n## Rollout\\n\\nMonitor the rollout. Pause if the error rate rises and confirm the review is finished.', { headers: { 'Content-Type': 'text/markdown' } }));
            return real(u, options);
        }; return true;
    })()`;

 const open=async width=>{
  await Emulation.setDeviceMetricsOverride({width,height:width===390?844:800,deviceScaleFactor:1,mobile:width===390});
  await Emulation.setTouchEmulationEnabled({enabled:width===390});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await ev(fixture);
  await ev(`window.__drafts=[{id:1,body:'Name the rollback owner before launch.',anchor:{whole:true},source:'owner',images:[]}];window.__revision=1;window.__refuse=true;true`);
  await ev(`import(${S}+'artifact_viewer.js').then(m=>m.openArtifactViewer('${HEX}',{filename:'Release plan',board:'draft-test'}))`);
  await waitFor(`!!document.querySelector('.ac-draft-card') && !document.querySelector('.ac-draft-bar button.btn-primary')?.disabled`,'review ready');await ev(framesJs(3));
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Emulation.setTimezoneOverride({timezoneId:'UTC'});
  const results=[];
  for(const width of [1280,390]){
   await open(width);await ev(`document.querySelector('.ac-draft-card').scrollIntoView({block:'nearest'});true`);await shot('composer-'+width);
   await click('.ac-draft-bar button.btn-primary');
   await waitFor(`document.querySelector('.ac-error:not([hidden])')?.textContent.includes('Agent unavailable')`,'inline send failure');
   await ev(`document.querySelector('.ac-error:not([hidden])').scrollIntoView({block:'center'});true`);await ev(framesJs(3));await shot('failed-'+width);
   results.push(await ev(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),close=r('.artifact-review-close'),changes=r('.artifact-review-changes'),approve=r('.artifact-review-approve'),title=r('.artifact-viewer-title'),more=r('.artifact-viewer-more'),buttons=[...document.querySelectorAll('.ac-draft-card .ac-comment-icon')];return {width:innerWidth,headerAligned:Math.abs(close.y-changes.y)<1&&Math.abs(close.y-approve.y)<1,titleAligned:Math.abs((title.top+title.bottom)/2-(more.top+more.bottom)/2)<2,icons:buttons.map(b=>({name:b.getAttribute('aria-label'),title:b.title,hidden:b.querySelector('.material-icons')?.getAttribute('aria-hidden'),height:b.getBoundingClientRect().height,width:b.getBoundingClientRect().width})),duplicateToast:[...document.querySelectorAll('#toast-host .toast')].some(t=>t.textContent.includes('Agent unavailable')),drafts:window.__drafts.length};})()`));
  }
  for(const r of results){
   assert.deepEqual(r.icons.map(b=>b.name),['Edit comment','Delete comment'],'draft actions are accessible icons at '+r.width);
   assert.ok(r.icons.every(b=>b.title===b.name&&b.hidden==='true'&&(r.width!==390||(b.height>=44&&b.width>=44))),'icon names and touch targets at '+r.width);
   if(r.width===390)assert.ok(r.headerAligned&&r.titleAligned,'phone title row and single aligned decision row');
   assert.equal(r.duplicateToast,false,'review error stays inline without a floating duplicate');assert.equal(r.drafts,1,'failed send retains saved draft');
  }
  // The existing draft editor and delete action still work by real pointer clicks.
  await click('.ac-draft-card [aria-label="Edit comment"]');
  await waitFor(`!!document.querySelector('.ac-draft-card textarea')`,'draft editor');
  await click('.ac-draft-card textarea');await ev(`document.querySelector('.ac-draft-card textarea').select();true`);await Input.insertText({text:'Confirm the rollback owner.'});
  await ev(`document.querySelector('.ac-draft-card button').click();true`);
  await waitFor(`window.__drafts[0].body==='Confirm the rollback owner.' && !!document.querySelector('.ac-draft-card [aria-label="Delete comment"]:not(:disabled)')`,'draft edit saved');
  await click('.ac-draft-card [aria-label="Delete comment"]');await waitFor('window.__drafts.length===0','private draft removed');assert.equal(await ev('window.__batches.length'),0);
  // Published owner comments use the same accessible icon pair.
  await ev(`window.__published=[{id:77,body:'Keep a rollback plan.',parent_id:null,anchor:{whole:true},author:{kind:'owner',subject:'Operator'},created_at:new Date().toISOString(),can:{edit:true,delete:true}}];true`);
  await ev(`import(${S}+'artifact_viewer.js').then(m=>m.openArtifactViewer('${HEX}',{filename:'Release plan',board:'draft-test'}))`);
  await waitFor(`!!document.querySelector('.ac-card [aria-label="Edit comment"]') && !!document.querySelector('.ac-card [aria-label="Delete comment"]')`,'published comment icon pair');
  console.log('PASS review header actions: aligned phone header, inline errors, retained drafts, named icon actions and private edit/delete at 1280/390');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
