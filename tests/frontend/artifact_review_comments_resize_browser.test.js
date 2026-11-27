// #21814: review comments retain pointer/keyboard resizing and a saved width.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const {coralReady, framesJs} = require('./helpers/wait');
const {BASE} = require('./test_base');
const HEX='d'.repeat(64), OTHER='e'.repeat(64);
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {Input}=client, S=`(window.__coralStatic || '/static/')`;
 const shot=require('./helpers/scene_shots')(Page,'review-comments-resize');
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

 const frames=()=>ev(framesJs(4));
 const width=()=>ev(`Math.round(document.querySelector('.artifact-viewer .ac-panel').getBoundingClientRect().width)`);
 const open=async w=>{
  await Emulation.setDeviceMetricsOverride({width:w,height:800,deviceScaleFactor:1,mobile:w===390});
  await Emulation.setTouchEmulationEnabled({enabled:w===390});
  await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await ev(fixture);
  await ev(`import(${S}+'artifact_viewer.js').then(m=>m.openArtifactViewer('${HEX}',{filename:'Release plan',board:'draft-test'}))`);
  await waitFor(`!!document.querySelector('.artifact-viewer[data-document-review] .ac-panel.ac-sheet-open')`,'review comments open');await frames();
 };
 const key=async k=>{for(const type of ['keyDown','keyUp'])await Input.dispatchKeyEvent({type,key:k,code:k,windowsVirtualKeyCode:{ArrowLeft:37,ArrowRight:39,Home:36,End:35}[k]});await frames();};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});await Emulation.setTimezoneOverride({timezoneId:'UTC'});
  await open(1280);await ev(`localStorage.removeItem('coral-artifact-comments-width');true`);await open(1280);
  await shot('before-drag-1280');
  const handle=await ev(`(()=>{const e=document.querySelector('.artifact-viewer .ac-resizer'),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+100;return{visible:!!e.getClientRects().length,x,y,hit:document.elementFromPoint(x,y)===e,role:e.getAttribute('role')};})()`);
  assert.equal(handle.visible,true,'document review has a visible resize separator');assert.equal(handle.hit,true,'the separator can be reached by the pointer');assert.equal(handle.role,'separator');
  const initial=await width();const room=await ev(`document.querySelector('.artifact-viewer-main').getBoundingClientRect().width`);assert.ok(Math.abs(initial-room*0.44)<=1,'unsaved review column keeps its approved 44% default');
  for(const [type,x] of [['mousePressed',handle.x],['mouseMoved',handle.x-96],['mouseReleased',handle.x-96]])await Input.dispatchMouseEvent({type,x,y:handle.y,button:'left',clickCount:1});await frames();
  const dragged=await width();assert.ok(Math.abs(dragged-initial-96)<=2,`pointer drag changes the actual column width: ${initial} -> ${dragged}`);
  await shot('after-drag-1280');await key('ArrowRight');assert.ok(Math.abs(await width()-dragged+16)<=1,'ArrowRight narrows by 16');
  await key('ArrowLeft');assert.equal(await width(),dragged,'ArrowLeft widens back');
  const bounds=await ev(`(()=>{const e=document.querySelector('.ac-resizer');return{min:+e.getAttribute('aria-valuemin'),max:+e.getAttribute('aria-valuemax')};})()`);
  await key('End');assert.equal(await width(),bounds.max);await key('Home');assert.equal(await width(),bounds.min);await key('ArrowLeft');const kept=await width();
  await open(1280);assert.equal(await width(),kept,'width survives page reload and viewer reopen');
  assert.equal(await ev(`+document.querySelector('.ac-resizer').getAttribute('aria-valuenow')`),kept,'separator value agrees with actual width');
  await open(390);assert.equal(await ev(`document.querySelector('.ac-resizer').getClientRects().length`),0,'phone review remains stacked without a resize handle');
  assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no phone horizontal overflow');
  console.log('PASS document review comments: pointer drag, arrows, Home/End, persisted width and stacked phone');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
