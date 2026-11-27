// #21847: a completed whole-document comment closes; a second intentional comment can send.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const {coralReady, framesJs} = require('./helpers/wait');
const {BASE} = require('./test_base');
const HEX='d'.repeat(64), OTHER='e'.repeat(64);
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {Input}=client, S=`(window.__coralStatic || '/static/')`;
 const shot=require('./helpers/scene_shots')(Page,'whole-comment');
 const click=async selector=>{
  const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,ok:h===e||e.contains(h)};})()`);
  assert.ok(p.ok,selector+' is reachable');
  await Input.dispatchMouseEvent({type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
  await Input.dispatchMouseEvent({type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});
 };
 const type=async text=>{await click('.ac-composer textarea');await Input.insertText({text});};
    const fixture = `(() => {
        const real = fetch;
        window.__reviewRow = { id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'Release plan', media_type: 'text/markdown', available: true, tags: ['for review'], team: 'draft-test', board_id: 'draft-test', produced_by: 'Frontend Dev', version: 2, created_at: new Date().toISOString() }; window.__draftBoards = []; window.__drafts = []; window.__revision = 0; window.__writes = []; window.__batches = []; window.__unknown = false; window.__refuse = false; window.__seen = {}; window.__published = []; window.__decisions = []; window.__decisionReplay = null; window.__loseDecision = false;
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
                window.__draftBoards.push(url.searchParams.get('board') || body.board);
                if (method === 'GET' && window.__draftsStatus) return json({ error: 'refused', message: 'refused' }, window.__draftsStatus); // a Hub without the route (404), a person who may not keep drafts (403)
                if (method === 'GET') return json({ drafts: url.pathname.includes('${OTHER}') ? [] : window.__drafts, revision: window.__revision, count: url.pathname.includes('${OTHER}') ? 0 : window.__drafts.length, drafts_supported: true, can_write: window.__writeAllowed !== false, can_send: window.__drafts.length > 0 && window.__sendAllowed !== false, reason: window.__reason || '', targets: window.__targets || ['Builder'] });
                window.__writes.push({ url: url.pathname, method, body });
                if (url.pathname.endsWith('/send')) {
                    if (window.__refuse) return json({ code: window.__refuseCode || 'not_delivered', error: window.__refuseWords || 'Agent unavailable. Drafts kept.' }, 409);
                    if (window.__seen[body.request_id]) return json({ ...window.__seen[body.request_id], replayed: true });
                    if (body.revision !== window.__revision) return json({ code: 'stale_revision', error: 'Drafts changed. Reload before sending.' }, 409);
                    window.__batches.push(window.__drafts.map(d => ({ ...d })));
                    window.__published.push(...window.__drafts.map(d => ({ ...d, author: { kind: 'owner', subject: 'Operator' }, asks: [{ agent: 'Builder', open: true }], created_at: new Date().toISOString(), can: {} })));
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
 const open=async (width,unavailable=false)=>{
  await Emulation.setDeviceMetricsOverride({width,height:width===390?844:800,deviceScaleFactor:1,mobile:width===390});
  await Emulation.setTouchEmulationEnabled({enabled:width===390});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await ev(fixture);
  await ev(`import(${S}+'state.js').then(m=>{m.state.selectedTeam='viewing-team';return true;})`);
  if(unavailable)await ev(`window.__sendAllowed=false;window.__reason='no_uploader';window.__targets=[];true`);
  await ev(`window.__png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII='; true`);
  await ev(`import(${S}+'artifact_viewer.js').then(m=>m.openArtifactViewer('${HEX}',{filename:'Release plan',board:'draft-test'}))`);
  await waitFor(`!!document.querySelector('.ac-composer textarea') && document.getElementById('artifact-viewer').hasAttribute('data-document-review')`,'review composer');await ev(framesJs(3));
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setTimezoneOverride({timezoneId:'UTC'});
  const checks=[];
  for(const width of [1280,390]){
   await open(width);
   await type('Name the rollback owner.');
   checks.push([`${width}: first typed comment can send`,await ev(`!document.querySelector('.ac-save-send').disabled`)]);
   // Save first so baseline can reach the second Send even with no-drafts can_send=false.
   await click('.ac-composer .ac-send:not(.ac-save-send)');
   await waitFor(`window.__drafts.length===1 && !!document.querySelector('.ac-draft-card')`,'private comment in the list');
   await waitFor(`!document.querySelector('.ac-composer textarea') || document.querySelector('.ac-composer textarea').value===''`,'editor reset after save');
   checks.push([`${width}: Save closes the composer`,!await ev(`!!document.querySelector('.ac-composer textarea')`)]);
   if(!await ev(`!!document.querySelector('.ac-composer textarea')`))await click('.ac-whole');
   await type('Confirm the second whole-document comment.');
   await click('.ac-save-send');
   await waitFor(`window.__batches.length===1 && window.__drafts.length===0`,'whole comments delivered');
   await waitFor(`!document.querySelector('.ac-composer textarea') || document.querySelector('.ac-composer textarea').value===''`,'editor reset after send');
   checks.push([`${width}: Send closes the composer`,!await ev(`!!document.querySelector('.ac-composer textarea')`)]);
   await shot('closed-'+width);
   if(!await ev(`!!document.querySelector('.ac-composer textarea')`))await click('.ac-whole');
   await type('Please confirm the rollout owner.');
   const enabled=await ev(`!document.querySelector('.ac-save-send').disabled`);
   if(enabled)await waitFor(`(() => { const b=document.querySelector('.ac-save-send'); getComputedStyle(b).backgroundColor; return !b.disabled && b.getAnimations().every(a=>a.playState==='finished'); })()`,'enabled Send finishes its color transition');
   await shot('second-'+width);
   checks.push([`${width}: second typed comment can send with no saved drafts`,enabled]);
   if(enabled){await click('.ac-save-send');await waitFor(`window.__batches.length===2 && window.__drafts.length===0`,'second intentional comment delivered');
    checks.push([`${width}: only the new comment is in the second batch`,await ev(`window.__batches[1].length===1 && window.__batches[1][0].body==='Please confirm the rollout owner.'`)]);
    checks.push([`${width}: second Send closes the composer`,!await ev(`!!document.querySelector('.ac-composer textarea')`)]);
    await click('.ac-whole');await type('Keep this feedback if delivery fails.');await ev(`window.__refuse=true;true`);await click('.ac-save-send');
    await waitFor(`window.__drafts.length===1 && /Agent unavailable/.test(document.querySelector('.ac-error:not([hidden])')?.textContent || '')`,'saved draft and delivery error stay visible');
    checks.push([`${width}: failed send retains one saved draft without another editor`,!await ev(`!!document.querySelector('.ac-composer textarea')`)]);
   }
   checks.push([`${width}: another team's directly opened file uses its own board`,await ev(`window.__draftBoards.length>0 && window.__draftBoards.every(b=>b==='draft-test')`)]);
   await open(width,true);await type('Feedback for a file without an uploader.');
   checks.push([`${width}: unavailable Send has an adjacent written reason`,await ev(`document.querySelector('.ac-save-send').disabled && /No agent is recorded/.test(document.querySelector('.ac-composer-send-reason:not([hidden])')?.textContent || '')`)]);
   await shot('unavailable-'+width);
  }
  for(const [label,ok] of checks)console.log(`[${ok?'PASS':'FAIL'}] ${label}`);
  assert.ok(checks.every(([,ok])=>ok),'all whole-document composer checks pass');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
