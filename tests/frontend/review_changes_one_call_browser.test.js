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
        for (const mode of ['one', 'older', 'older-comment-refused', 'older-comment-lost', 'older-send-refused', 'older-send-lost', 'older-send-lost-file', 'older-send-lost-words', 'pictures', 'in-progress', 'not-delivered', 'already-sent', 'hub', 'held-close', 'held-switch', 'text-not-kept', 'unsupported-images', 'other-refusal', 'cloud', 'cloud-older', 'too-long', 'saved']) {
            try {
                if (mode === 'cloud' || mode === 'cloud-older') await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false, inbox: true, hubFeed: true });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'settings');
                await ev(`(async () => {
                    const mode = ${JSON.stringify(mode)}, server = (mode === 'hub' || mode === 'cloud' || mode === 'cloud-older') ? 'review-box' : 'local';
                    const { state } = await import((window.__coralStatic || '/static/') + 'state.js');
                    state.hub = true; state.serversKnown = true; state.servers = [{id:'review-box',status:'online',owner_stamp:true}];
                    const real = window.fetch, json = (body,status=200) => Promise.resolve(Response.json(body,{status}));
                    window.__writes = []; window.__stateReads = 0; window.__reloads = 0;
                    const row = {id:'${HEX}',uri:'coral://artifacts/${HEX}',board_id:'alpha',name:'Plan.md',produced_by:'Writer A',available:true,tags:['for review',...(mode==='saved'?['saved']:[])]};
                    const prefix = server === 'local' ? '' : '/api/remote/review-box';
                    window.fetch = (input,opts={}) => {
                        const u = new URL(String(input),location.href), path = u.pathname, method = opts.method || 'GET';
                        if (method === 'GET' && (path === prefix+'/api/board/alpha/artifacts' || path === prefix+'/api/team-artifacts')) { if (path.endsWith('/api/board/alpha/artifacts') || u.searchParams.has('digest')) window.__stateReads++; const rows = [row, ...((mode === 'held-switch' || mode.startsWith('older-send-lost-')) ? [{...row,id:'${OTHER}',uri:'coral://artifacts/${OTHER}',name:'Replacement.md'}] : [])].filter(r=>!u.searchParams.has('digest') || r.id===u.searchParams.get('digest')); return json({artifacts:rows,total:rows.length,tag_counts:{'for review':rows.length},has_more:false}); }
                        if (method === 'POST' && path.startsWith(prefix+'/api/') && (path.endsWith('/review') || path.endsWith('/comments') || path.endsWith('/send'))) {
                            const body = JSON.parse(opts.body); window.__writes.push({path,body});
                            if (path.endsWith('/review')) {
                                if (mode === 'held-close' || mode === 'held-switch') return new Promise(resolve=>{window.__releaseDecision=()=>resolve(Response.json({text_kept:true,comment_id:7,delivered:true,to:'Writer A'}));});
                                if (mode === 'text-not-kept') return json({text_kept:false,delivered:false});
                                if (mode === 'other-refusal') return json({code:'words_not_supported',message:'Write refused.'},400);
                                if (mode === 'unsupported-images' && body.text) return json({code:'images_not_in_this_slice',message:'Use a comment for pictures.'},400);
                                if (mode === 'in-progress') return json({code:'already_in_progress',message:'retry in a moment'},409);
                                if (mode.startsWith('older') || mode === 'pictures' || mode === 'cloud-older') return json({state:'changes requested',delivered:false});
                                return json({state:'changes requested',text_kept:true,comment_id:7,delivered:mode!=='not-delivered' && mode!=='already-sent',...(mode==='not-delivered'?{reason:'agent_unavailable'}:mode==='already-sent'?{reason:'already_sent'}:{to:'Writer A'})});
                            }
                            if (path.endsWith('/comments') && mode === 'cloud-older') return json({error:'not_found'},404); // the Hub keeps comment writes closed until its flag is on (#14797)
                            if (path.endsWith('/comments') && mode === 'older-comment-refused') return json({error:'Comment refused'},403);
                            if (path.endsWith('/comments') && mode === 'older-comment-lost') return Promise.reject(new TypeError('Connection lost'));
                            if (path.endsWith('/send') && mode.startsWith('older-send-lost') && !window.__retryDelivery) return Promise.reject(new TypeError('Delivery acknowledgement lost'));
                            if (path.endsWith('/send') && mode === 'older-send-refused' && !window.__retryDelivery) return json({ok:false,error:'Delivery refused',results:[{agent:'Writer A',state:'refused'}]},403);
                            if (path.endsWith('/send')) return json({ok:true,results:[{state:'sent',agent:'Writer A'}]});
                            return json({id:path.includes('${OTHER}')?8:7,body:body.body,images:body.images || []},201);
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
                await ev(`document.querySelector('#one-call-review textarea').value=${JSON.stringify(mode === 'too-long' ? 'é'.repeat(501) : 'Keep these exact words.')}; document.querySelector('#one-call-review form').requestSubmit(); true`);
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
                } else if (mode.startsWith('older-send-lost-')) { // #14263: QA Reviewer 2's two surviving mutants on #14187: the kept comment of a lost send is the FILE's and the WORDS'
                    await waitFor(`!!document.querySelector('#one-call-review .artifact-review-error').textContent`, mode + ': the lost send leaves the form with its error');
                    assert.equal(await ev(`window.__writes.filter(w=>w.path.endsWith('/comments')).length`),1,mode+': one comment after the first, lost, send');
                    if (mode === 'older-send-lost-file') {
                        await ev(`window.__control.open('${OTHER}',{server:'local',board:'alpha',sourceNamed:true,requestChanges:true}).then(()=>true)`);
                        await waitFor(`!document.querySelector('#one-call-review .artifact-review-form').hidden`, 'the form opens for the other file');
                        await ev(`document.querySelector('#one-call-review textarea').value='Keep these exact words.'; document.querySelector('#one-call-review form').requestSubmit(); true`); // the SAME words, another file
                    } else {
                        await ev(`document.querySelector('#one-call-review textarea').value='Different words after the loss.'; document.querySelector('#one-call-review form').requestSubmit(); true`);
                    }
                    await waitFor(`window.__writes.filter(w=>w.path.endsWith('/comments')).length === 2`, mode + ': a second comment is posted; the lost one is not reused');
                    const writes = await ev(`window.__writes`), comments = writes.filter(w=>w.path.endsWith('/comments')), reviews = writes.filter(w=>w.path.endsWith('/review'));
                    if (mode === 'older-send-lost-file') {
                        assert.ok(comments[0].path.includes(HEX) && comments[1].path.includes(OTHER), mode+': the second comment goes to the OTHER file, not the first');
                        assert.equal(comments[1].body.body,'Changes requested: Keep these exact words.');
                        assert.equal(reviews.length,2,mode+': the other file is decided too: the first file\'s recorded decision is not reused for it');
                        assert.ok(reviews[0].path.includes(HEX) && reviews[1].path.includes(OTHER),mode+': each decision is on its own file');
                    } else {
                        assert.ok(comments[1].path.includes(HEX),mode+': the same file');
                        assert.equal(comments[1].body.body,'Changes requested: Different words after the loss.',mode+': changed words are a NEW comment with the new words');
                        assert.equal(reviews.length,1,mode+': the recorded decision is not repeated for changed words');
                    }
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
                } else if (mode === 'too-long') {
                    await waitFor(`/Keep it to 500 characters: it is 501/.test(document.querySelector('#one-call-review .artifact-review-error').textContent)`, 'the 501-character words are refused in the form, before sending');
                    assert.equal(await ev(`window.__writes.length`),0,'501 characters (not bytes) are never sent: the Hub takes 1 to 500 (#14797)');
                    assert.equal(await ev(`document.querySelector('#one-call-review textarea').value.length`),501,'the words are kept, never cut');
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
                    if (['one', 'not-delivered', 'already-sent', 'hub', 'cloud', 'saved'].includes(mode)) {
                        assert.equal(writes.length,1,mode+' is one call');
                        assert.ok(writes[0].path.endsWith('/review')); assert.equal(writes[0].body.text,'Keep these exact words.');
                        assert.equal(writes[0].body.decision,'changes');
                    } else if (mode !== 'cloud-older') {
                        assert.equal(writes.length,mode==='unsupported-images'?4:3,mode+' counts every request, including the explicit unsupported refusal');
                        if (mode === 'pictures') assert.ok(writes.every(w=>!Object.hasOwn(w.body,'text')),'pictures never send a one-call text request');
                        if (mode === 'unsupported-images') { assert.equal(writes[0].body.text,'Keep these exact words.'); assert.equal(Object.hasOwn(writes.at(-1).body,'text'),false,'the fallback decision carries no text'); }
                        if (mode === 'older') { assert.ok(writes[0].path.endsWith('/review')); assert.equal(writes[0].body.text,'Keep these exact words.','older computer is negotiated before falling back'); }
                        assert.equal(writes.filter(w=>w.path.endsWith('/review')).length,mode==='unsupported-images'?2:1,'no duplicate accepted decision');
                        const comment=writes.find(w=>w.path.endsWith('/comments'));
                        assert.equal(comment.body.body,'Changes requested: Keep these exact words.');
                        assert.deepEqual(comment.body.images || [],mode==='pictures'?[PIC]:[]);
                    }
                    if (mode === 'cloud-older') {
                        assert.equal(writes.length,1,'Hub with comment writes off: the decision is the one call; no comment, no send (#14797)');
                        assert.ok(writes[0].path.endsWith('/review') && writes[0].body.decision === 'changes' && writes[0].body.text === 'Keep these exact words.','that one call is the review with the words');
                        assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/not_found/.test(t.textContent))`),false,'no bare error code is shown');
                        assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/Changes requested/.test(t.textContent))`),true,'the person is told changes were requested');
                    }
                    if (mode === 'cloud') assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/Changes requested\. Your words are on the file\./.test(t.textContent))`),true,'Hub, comment writes off, the computer kept the words (text_kept): the toast says they are on the file (#14797)');
                    if (mode === 'cloud-older') assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/Your words were not added to the thread/.test(t.textContent))`),true,'an older computer dropped the words: the toast says they were not added');
                    if (mode === 'hub' || mode === 'cloud') assert.ok(writes.every(w=>w.path.startsWith('/api/remote/review-box/')),'all writes retain the captured computer');
                    if (mode === 'cloud' || mode === 'cloud-older') assert.equal(await ev(`import((window.__coralStatic || '/static/')+'server_base.js').then(m=>m.isCloud())`),true,'the Cloud Hub boot mode is exercised');
                    if (mode === 'already-sent') assert.match(await ev(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ')`),/Writer A was already told/);
                    if (mode === 'not-delivered') {
                        const toast=await ev(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ')`);
                        assert.match(toast,/Writer A.*not.*told/i); assert.match(toast,/agent unavailable/i); assert.match(toast,/words are in the thread/i); assert.doesNotMatch(toast,/was asked/);
                    }
                    if (mode === 'saved') assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/Moved out of Saved/.test(t.textContent))`),true,'a saved item\'s changes-requested toast says it moved out of Saved (#16864 F16)');
                    if (mode === 'one') assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/Moved out of Saved/.test(t.textContent))`),false,'a non-saved item does not mention Saved');
                }
                console.log('PASS '+mode);
            } catch (e) { failures.push(mode+': '+e.message); console.error(failures.at(-1)); }
        }
    } finally { await client.close(); }
    assert.deepEqual(failures,[]);
})().catch(e=>{console.error(e);process.exitCode=1;});
