// #14010: real Request changes controls negotiate one decision call, preserve legacy pictures,
// and distinguish an in-progress notice from a successful or undelivered request.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld } = require('./helpers/hub_world');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'c'.repeat(64), PIC = 'd'.repeat(64), OTHER = 'e'.repeat(64);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const mode of ['one', 'older', 'older-comment-refused', 'older-comment-lost', 'older-send-refused', 'older-send-lost', 'pictures', 'in-progress', 'not-delivered', 'already-sent', 'hub', 'held-close', 'held-switch', 'text-not-kept', 'unsupported-images', 'other-refusal', 'cloud']) {
            try {
                if (mode === 'cloud') await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false, inbox: true, hubFeed: true });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'settings');
                await ev(`(async () => {
                    const mode = ${JSON.stringify(mode)}, server = (mode === 'hub' || mode === 'cloud') ? 'review-box' : 'local';
                    const { state } = await import((window.__coralStatic || '/static/') + 'state.js');
                    state.hub = true; state.serversKnown = true; state.servers = [{id:'review-box',status:'online',owner_stamp:true}];
                    const real = window.fetch, json = (body,status=200) => Promise.resolve(Response.json(body,{status}));
                    window.__writes = []; window.__stateReads = 0; window.__reloads = 0;
                    const row = {id:'${HEX}',uri:'coral://artifacts/${HEX}',board_id:'alpha',name:'Plan.md',produced_by:'Writer A',available:true,tags:['for review']};
                    const prefix = server === 'local' ? '' : '/api/remote/review-box';
                    window.fetch = (input,opts={}) => {
                        const u = new URL(String(input),location.href), path = u.pathname, method = opts.method || 'GET';
                        if (method === 'GET' && (path === prefix+'/api/board/alpha/artifacts' || path === prefix+'/api/team-artifacts')) { if (path.endsWith('/api/board/alpha/artifacts') || u.searchParams.has('digest')) window.__stateReads++; const rows = [row, ...(mode === 'held-switch' ? [{...row,id:'${OTHER}',uri:'coral://artifacts/${OTHER}',name:'Replacement.md'}] : [])].filter(r=>!u.searchParams.has('digest') || r.id===u.searchParams.get('digest')); return json({artifacts:rows,total:rows.length,tag_counts:{'for review':rows.length},has_more:false}); }
                        if (method === 'POST' && path.startsWith(prefix+'/api/') && (path.endsWith('/review') || path.endsWith('/comments') || path.endsWith('/send'))) {
                            const body = JSON.parse(opts.body); window.__writes.push({path,body});
                            if (path.endsWith('/review')) {
                                if (mode === 'held-close' || mode === 'held-switch') return new Promise(resolve=>{window.__releaseDecision=()=>resolve(Response.json({text_kept:true,comment_id:7,delivered:true,to:'Writer A'}));});
                                if (mode === 'text-not-kept') return json({text_kept:false,delivered:false});
                                if (mode === 'other-refusal') return json({code:'words_not_supported',message:'Write refused.'},400);
                                if (mode === 'unsupported-images' && body.text) return json({code:'images_not_in_this_slice',message:'Use a comment for pictures.'},400);
                                if (mode === 'in-progress') return json({code:'already_in_progress',message:'retry in a moment'},409);
                                if (mode.startsWith('older') || mode === 'pictures') return json({state:'changes requested',delivered:false});
                                return json({state:'changes requested',text_kept:true,comment_id:7,delivered:mode!=='not-delivered' && mode!=='already-sent',...(mode==='not-delivered'?{reason:'agent_unavailable'}:mode==='already-sent'?{reason:'already_sent'}:{to:'Writer A'})});
                            }
                            if (path.endsWith('/comments') && mode === 'older-comment-refused') return json({error:'Comment refused'},403);
                            if (path.endsWith('/comments') && mode === 'older-comment-lost') return Promise.reject(new TypeError('Connection lost'));
                            if (path.endsWith('/send') && mode === 'older-send-lost' && !window.__retryDelivery) return Promise.reject(new TypeError('Delivery acknowledgement lost'));
                            if (path.endsWith('/send') && mode === 'older-send-refused' && !window.__retryDelivery) return json({ok:false,error:'Delivery refused',results:[{agent:'Writer A',state:'refused'}]},403);
                            if (path.endsWith('/send')) return json({ok:true,results:[{state:'sent',agent:'Writer A'}]});
                            return json({id:7,body:body.body,images:body.images || []},201);
                        }
                        if (method === 'POST' && path === prefix+'/api/artifacts/${HEX}/comment-images') return json({hex:'${PIC}',name:'example.png',content_type:'image/png',size:70});
                        return real(input,opts);
                    };
                    const host = document.createElement('section'); host.id = 'one-call-review'; host.innerHTML='<div class="artifact-viewer-header"></div>'; document.body.append(host);
                    const { attachReview } = await import((window.__coralStatic || '/static/')+'artifact_review.js');
                    window.__control = attachReview(host,{reload:()=>{window.__reloads++;}});
                    await window.__control.open('${HEX}',{server,board:'alpha',sourceNamed:true,requestChanges:true});
                    return true;
                })()`);
                await waitFor(`!document.querySelector('#one-call-review .artifact-review-form').hidden`, mode + ' opens form');
                if (mode === 'pictures') {
                    await ev(`(() => { const b=Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b],'example.png',{type:'image/png'})); const input=document.querySelector('#one-call-review .ac-picker input');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
                    await waitFor(`!!document.querySelector('#one-call-review .ac-thumb-ready')`, 'picture upload finishes');
                }
                await ev(`document.querySelector('#one-call-review textarea').value='Keep these exact words.'; document.querySelector('#one-call-review form').requestSubmit(); true`);
                if (mode === 'held-close' || mode === 'held-switch') {
                    await waitFor(`typeof window.__releaseDecision === 'function'`, 'the old response is held');
                    if (mode === 'held-close') await ev(`window.__control.close(); true`);
                    else await ev(`window.__control.open('${OTHER}',{server:'local',board:'alpha',sourceNamed:true,requestChanges:true}).then(()=>{document.querySelector('#one-call-review textarea').value='Replacement draft.';return true;})`);
                    await ev(`window.__releaseDecision(); true`); await ev(framesJs(3));
                    assert.equal(await ev(`window.__reloads`),0,'a late acknowledgement never reloads a closed or replacement viewer');
                    assert.equal(await ev(`document.querySelector('#one-call-review textarea').value`),mode==='held-close'?'Keep these exact words.':'Replacement draft.','late acknowledgement preserves the draft');
                    assert.equal(await ev(`window.__writes.length`),1,'switching never sends another request');
                    assert.ok((await ev(`window.__writes[0].path`)).includes(HEX),'the held write stays on the original file');
                    assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/was asked/.test(t.textContent))`),false,'late success cannot announce another file as sent');
                } else if (mode.startsWith('older-')) {
                    await waitFor(`!!document.querySelector('#one-call-review .artifact-review-error').textContent`, 'the older-computer fallback outcome');
                    const words = await ev(`document.querySelector('#one-call-review .artifact-review-error').textContent`);
                    assert.match(words,/decision was recorded/i);
                    assert.match(words,mode==='older-send-refused'?/words are in the thread.*could not be told/:mode==='older-send-lost'?/words are in the thread.*delivery.*not confirmed/:mode==='older-comment-lost'?/words were not confirmed.*draft is kept/:/words were not sent.*draft is kept/);
                    const writes=await ev('window.__writes');
                    assert.equal(writes.filter(w=>w.path.endsWith('/review')).length,1,'the older decision is not duplicated');
                    assert.equal(writes.length,mode.startsWith('older-send')?3:2,'only the negotiated decision and necessary fallback calls');
                    assert.equal(await ev('window.__reloads'),0,'fallback failure keeps the form open');
                    assert.equal(await ev(`document.querySelector('#one-call-review textarea').value`),'Keep these exact words.');
                    if(mode.startsWith('older-send')){
                        await ev(`window.__retryDelivery=true;document.querySelector('#one-call-review form').requestSubmit();true`);
                        await waitFor(`window.__reloads===1`,mode+' explicit retry succeeds');
                        const retried=await ev('window.__writes');
                        assert.equal(retried.filter(w=>w.path.endsWith('/review')).length,1,mode+': retry never repeats the recorded decision');
                        assert.equal(retried.filter(w=>w.path.endsWith('/comments')).length,1,mode+': retry reuses the confirmed comment');
                        const sends=retried.filter(w=>w.path.endsWith('/send'));
                        assert.equal(sends.length,2,mode+': retry sends only the existing comment');
                        assert.equal(sends[0].path,sends[1].path,mode+': both sends address the same comment');
                    }
                } else if (mode === 'text-not-kept' || mode === 'other-refusal') {
                    await waitFor(`!!document.querySelector('#one-call-review .artifact-review-error').textContent`, 'the refusal stays in the form');
                    const error = await ev(`document.querySelector('#one-call-review .artifact-review-error').textContent`);
                    assert.match(error,mode==='text-not-kept'?/did not confirm/:/Write refused/);
                    assert.equal(await ev(`window.__writes.length`),1,'a negative acknowledgement or unrelated refusal never falls back');
                    assert.equal(await ev(`window.__reloads`),0,'a refusal cannot claim success');
                    assert.equal(await ev(`document.querySelector('#one-call-review textarea').value`),'Keep these exact words.','the refused draft is retained');
                } else if (mode === 'in-progress') {
                    await waitFor(`/still sending/i.test(document.querySelector('#one-call-review').textContent)`, 'in-progress status is visible');
                    await waitFor(`/Sending is not yet confirmed/.test(document.querySelector('#one-call-review').textContent)`, 'the one pending-state read completes');
                    assert.equal(await ev(`window.__stateReads`),2,'initial state plus exactly one delayed re-read, excluding badge summaries');
                    assert.equal(await ev(`window.__writes.length`),1,'409 never falls back or resubmits');
                    assert.equal(await ev(`document.querySelector('#one-call-review textarea').value`),'Keep these exact words.');
                    assert.equal(await ev(`window.__reloads`),0,'409 never claims success');
                    assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/retry in a moment|already_in_progress/i.test(t.textContent))`),false,'no 409 error toast');
                } else {
                    await waitFor(`window.__reloads === 1`, mode + ' finishes');
                    const writes = await ev(`window.__writes`);
                    if (['one', 'not-delivered', 'already-sent', 'hub', 'cloud'].includes(mode)) {
                        assert.equal(writes.length,1,mode+' is one call');
                        assert.ok(writes[0].path.endsWith('/review')); assert.equal(writes[0].body.text,'Keep these exact words.');
                        assert.equal(writes[0].body.decision,'changes');
                    } else {
                        assert.equal(writes.length,mode==='unsupported-images'?4:3,mode+' counts every request, including the explicit unsupported refusal');
                        if (mode === 'pictures') assert.ok(writes.every(w=>!Object.hasOwn(w.body,'text')),'pictures never send a one-call text request');
                        if (mode === 'unsupported-images') { assert.equal(writes[0].body.text,'Keep these exact words.'); assert.equal(Object.hasOwn(writes.at(-1).body,'text'),false,'the fallback decision carries no text'); }
                        if (mode === 'older') { assert.ok(writes[0].path.endsWith('/review')); assert.equal(writes[0].body.text,'Keep these exact words.','older computer is negotiated before falling back'); }
                        assert.equal(writes.filter(w=>w.path.endsWith('/review')).length,mode==='unsupported-images'?2:1,'no duplicate accepted decision');
                        const comment=writes.find(w=>w.path.endsWith('/comments'));
                        assert.equal(comment.body.body,'Changes requested: Keep these exact words.');
                        assert.deepEqual(comment.body.images || [],mode==='pictures'?[PIC]:[]);
                    }
                    if (mode === 'hub' || mode === 'cloud') assert.ok(writes.every(w=>w.path.startsWith('/api/remote/review-box/')),'all writes retain the captured computer');
                    if (mode === 'cloud') assert.equal(await ev(`import((window.__coralStatic || '/static/')+'server_base.js').then(m=>m.isCloud())`),true,'the Cloud Hub boot mode is exercised');
                    if (mode === 'already-sent') assert.match(await ev(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ')`),/Writer A was already told/);
                    if (mode === 'not-delivered') {
                        const toast=await ev(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ')`);
                        assert.match(toast,/Writer A.*not.*told/i); assert.match(toast,/agent unavailable/i); assert.match(toast,/words are in the thread/i); assert.doesNotMatch(toast,/was asked/);
                    }
                }
                console.log('PASS '+mode);
            } catch (e) { failures.push(mode+': '+e.message); console.error(failures.at(-1)); }
        }
    } finally { await client.close(); }
    assert.deepEqual(failures,[]);
})().catch(e=>{console.error(e);process.exitCode=1;});
