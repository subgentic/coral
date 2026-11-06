// #14010: real Request changes controls negotiate one decision call, preserve legacy pictures,
// and distinguish an in-progress notice from a successful or undelivered request.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'c'.repeat(64), PIC = 'd'.repeat(64);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const mode of ['one', 'older', 'pictures', 'in-progress', 'not-delivered', 'hub']) {
            try {
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'settings');
                await ev(`(async () => {
                    const mode = ${JSON.stringify(mode)}, server = mode === 'hub' ? 'review-box' : 'local';
                    const { state } = await import((window.__coralStatic || '/static/') + 'state.js');
                    state.hub = true; state.serversKnown = true; state.servers = [{id:'review-box',status:'online',owner_stamp:true}];
                    const real = window.fetch, json = (body,status=200) => Promise.resolve(Response.json(body,{status}));
                    window.__writes = []; window.__stateReads = 0; window.__reloads = 0;
                    const row = {id:'${HEX}',uri:'coral://artifacts/${HEX}',board_id:'alpha',name:'Plan.md',produced_by:'Writer A',available:true,tags:['for review']};
                    const prefix = server === 'local' ? '' : '/api/remote/review-box';
                    window.fetch = (input,opts={}) => {
                        const u = new URL(String(input),location.href), path = u.pathname, method = opts.method || 'GET';
                        if (method === 'GET' && (path === prefix+'/api/board/alpha/artifacts' || path === prefix+'/api/team-artifacts')) { window.__stateReads++; return json({artifacts:[row],total:1,tag_counts:{'for review':1},has_more:false}); }
                        if (method === 'POST' && path.startsWith(prefix+'/api/') && (path.endsWith('/review') || path.endsWith('/comments') || path.endsWith('/send'))) {
                            const body = JSON.parse(opts.body); window.__writes.push({path,body});
                            if (path.endsWith('/review')) {
                                if (mode === 'in-progress') return json({code:'already_in_progress',message:'retry in a moment'},409);
                                if (mode === 'older' || mode === 'pictures') return json({state:'changes requested',delivered:false});
                                return json({state:'changes requested',text_kept:true,comment_id:7,delivered:mode!=='not-delivered',...(mode==='not-delivered'?{reason:'agent_unavailable'}:{to:'Writer A'})});
                            }
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
                if (mode === 'in-progress') {
                    await waitFor(`/still sending/i.test(document.querySelector('#one-call-review').textContent)`, 'in-progress status is visible');
                    await waitFor(`window.__stateReads >= 2`, 'in-progress is re-read once');
                    assert.equal(await ev(`window.__writes.length`),1,'409 never falls back or resubmits');
                    assert.equal(await ev(`document.querySelector('#one-call-review textarea').value`),'Keep these exact words.');
                    assert.equal(await ev(`window.__reloads`),0,'409 never claims success');
                    assert.equal(await ev(`[...document.querySelectorAll('.toast')].some(t=>/retry in a moment|already_in_progress/i.test(t.textContent))`),false,'no 409 error toast');
                } else {
                    await waitFor(`window.__reloads === 1`, mode + ' finishes');
                    const writes = await ev(`window.__writes`);
                    if (mode === 'one' || mode === 'not-delivered' || mode === 'hub') {
                        assert.equal(writes.length,1,mode+' is one call');
                        assert.ok(writes[0].path.endsWith('/review')); assert.equal(writes[0].body.text,'Keep these exact words.');
                        assert.equal(writes[0].body.decision,'changes');
                    } else {
                        assert.equal(writes.length,3,mode+' uses exactly three writes');
                        assert.equal(writes.filter(w=>w.path.endsWith('/review')).length,1,'no duplicate decision');
                        const comment=writes.find(w=>w.path.endsWith('/comments'));
                        assert.equal(comment.body.body,'Changes requested: Keep these exact words.');
                        assert.deepEqual(comment.body.images || [],mode==='pictures'?[PIC]:[]);
                    }
                    if (mode === 'hub') assert.ok(writes.every(w=>w.path.startsWith('/api/remote/review-box/')),'all writes retain the captured computer');
                    if (mode === 'not-delivered') {
                        const toast=await ev(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ')`);
                        assert.match(toast,/Writer A.*not.*told/i); assert.match(toast,/agent unavailable/i); assert.doesNotMatch(toast,/was asked/);
                    }
                }
                console.log('PASS '+mode);
            } catch (e) { failures.push(mode+': '+e.message); console.error(failures.at(-1)); }
        }
    } finally { await client.close(); }
    assert.deepEqual(failures,[]);
})().catch(e=>{console.error(e);process.exitCode=1;});
