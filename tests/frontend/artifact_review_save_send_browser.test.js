// #21688: real composer clicks save a private draft, then send the review's full batch.
const assert = require('node:assert/strict');
const {connect} = require('./agent_view_harness');
const {coralReady, framesJs} = require('./helpers/wait');
const {BASE} = require('./test_base');
const HEX='d'.repeat(64), OTHER='e'.repeat(64);
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
 const {Input}=client, S=`(window.__coralStatic || '/static/')`;
 const shot=require('./helpers/scene_shots')(Page,'save-and-send');
 const click=async selector=>{
  const p=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,ok:h===e||e.contains(h)};})()`);
  assert.ok(p.ok,selector+' is reachable');
  await Input.dispatchMouseEvent({type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
  await Input.dispatchMouseEvent({type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});
 };
 const type=async text=>{await click('.ac-composer textarea');await Input.insertText({text});};
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
  await ev(`window.__png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII='; true`);
  await ev(`import(${S}+'artifact_viewer.js').then(m=>m.openArtifactViewer('${HEX}',{filename:'Release plan',board:'draft-test'}))`);
  await waitFor(`!!document.querySelector('.ac-composer textarea') && document.getElementById('artifact-viewer').hasAttribute('data-document-review')`,'review composer');await ev(framesJs(3));
 };
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setTimezoneOverride({timezoneId:'UTC'});
  // Capture both requested widths before asserting the new action, so the old head supplies both before shots.
  for(const width of [1280,390]){await open(width);await type('Name the rollback owner.');await shot('composer-'+width);}
  assert.equal(await ev(`document.querySelector('.ac-save-send')?.textContent`),'Send','the composer offers one-click Save and send');
  for(const width of [1280,390]){
   await open(width);
   assert.ok(await ev(`(()=>{const a=document.querySelector('.ac-composer .ac-send').getBoundingClientRect(),b=document.querySelector('.ac-save-send').getBoundingClientRect();return Math.abs(a.y-b.y)<1 && b.right<=innerWidth;})()`),'Save draft and Save and send stay adjacent and fit');
   const labels=await ev(`[...document.querySelectorAll('.ac-composer-row button')].map(b=>b.getAttribute('aria-label') || b.textContent)`);
   assert.deepEqual(labels,['Add image','Cancel','Save','Send comment']);
   assert.ok(await ev(`!document.querySelector('.ac-composer .ac-send').classList.contains('btn-primary') && document.querySelector('.ac-save-send').classList.contains('btn-primary')`));
   assert.match(await ev(`document.querySelector('.ac-draft-save-hint').textContent`),/Send comments.*Send/);
   assert.ok(await ev(`(()=>{const buttons=[...document.querySelectorAll('.ac-composer-row button')],r=buttons.map(b=>b.getBoundingClientRect()),field=document.querySelector('.ac-composer textarea').getBoundingClientRect();return buttons.every(b=>getComputedStyle(b).fontSize===getComputedStyle(buttons[0]).fontSize)&&r.every(b=>Math.abs(b.y-r[0].y)<1&&Math.abs(b.height-r[0].height)<1)&&Math.abs(r[0].left-field.left)<1&&Math.abs(r.at(-1).right-field.right)<1;})()`),'text actions share one baseline, size, and field edges');
   if(width===390){
    await ev(`document.querySelector('.ac-composer textarea').focus();true`);
    await Emulation.setDeviceMetricsOverride({width:390,height:440,deviceScaleFactor:1,mobile:true});
    await waitFor(`document.body.classList.contains('keyboard-open')`,'keyboard-open phone layout');
    await ev(`document.querySelector('.ac-composer textarea').scrollIntoView({block:'start'});true`);await ev(framesJs(3));
    await shot('keyboard-390');
    const keyboard=await ev(`({height:innerHeight,buttons:[...document.querySelectorAll('.ac-composer .ac-send')].map(b=>{const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:b.textContent,top:r.top,bottom:r.bottom,reachable:hit===b||b.contains(hit)};})})`);
    assert.ok(keyboard.buttons.every(b=>b.top>=0&&b.bottom<=keyboard.height&&b.reachable),'both draft and send actions fit above the phone keyboard: '+JSON.stringify(keyboard));
    await ev(`document.querySelector('.ac-composer textarea').blur();true`);
    await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});
    await waitFor(`!document.body.classList.contains('keyboard-open')`,'keyboard closed');
   }
   await type('Earlier private draft');await click('.ac-composer .ac-send');
   await waitFor(`window.__drafts.length===1 && document.querySelector('.ac-composer textarea')?.value===''`,'private draft saved');
   assert.equal(await ev('window.__batches.length'),0);
   await type('New whole-document feedback');
   await ev(`(()=>{const input=document.querySelector('.ac-composer input[type=file]'),d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(window.__png),c=>c.charCodeAt(0))],'review.png',{type:'image/png'}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
   await waitFor(`!!document.querySelector('.ac-composer .ac-thumb') && !document.querySelector('.ac-save-send').disabled`,'picture uploaded');
   await click('.ac-save-send');
   await waitFor(`window.__batches.length===1 && window.__drafts.length===0 && document.querySelector('.ac-composer textarea')?.value===''`,'saved and sent');
   assert.deepEqual(await ev(`window.__batches[0].map(d=>d.body)`),['Earlier private draft','New whole-document feedback']);
   assert.deepEqual(await ev(`window.__batches[0][1].images`),['f'.repeat(64)],'new pictures travel with the same batch');
   await type('Keep this feedback if delivery fails');await ev('window.__refuse=true;true');await click('.ac-save-send');
   await waitFor(`window.__drafts.length===1 && document.querySelector('.ac-error:not([hidden])')?.textContent.includes('Agent unavailable')`,'saved draft survives failed send');
   assert.equal(await ev(`window.__drafts[0].body`),'Keep this feedback if delivery fails');
   assert.equal(await ev(`document.querySelector('.ac-composer textarea').value`),'','saved comment is not left in the editor to duplicate');
   await ev(`document.querySelector('.ac-error:not([hidden])').scrollIntoView({block:'center'});true`);
   await shot('failed-'+width);
   await ev('window.__refuse=false;true');await click('.ac-draft-bar button.btn-primary');
   await waitFor(`window.__batches.length===2 && window.__drafts.length===0`,'retry existing saved draft');
   assert.equal(await ev(`window.__batches[1].length`),1,'retry does not duplicate the saved draft');
   // Passage comments use the same action and keep their anchor.
   await ev(`(()=>{const p=[...document.querySelectorAll('.artifact-viewer-body p')].find(p=>p.textContent.startsWith('Assign an owner'));const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,29);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));document.querySelector('.artifact-viewer-body').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true;})()`);
   await waitFor(`!!document.querySelector('.ac-selbtn:not([hidden])')`,'passage comment action');await click('.ac-selbtn');await type('Name the passage owner');
   await click('.ac-save-send');await waitFor('window.__batches.length===3','passage batch sent');
   assert.match(await ev(`window.__batches[2][0].anchor.quote`),/Assign an owner/);
   await type('Shortcut remains private');
   await Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',modifiers:4});await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',modifiers:4});
   await waitFor('window.__drafts.length===1','Cmd Return saves a private draft');
   assert.equal(await ev('window.__batches.length'),3);

  }
  console.log('PASS Save and send: whole and passage comments, full batch with pictures, failed send retains draft, retry without duplication, Cmd Return stays private at 1280/390');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
