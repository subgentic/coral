// #13535: a file sent for review without a team is visible locally and through Hub-world.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const remote of [false, true]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(async () => {
                const { state } = await import((window.__coralStatic || '/static/') + 'state.js');
                state.hub = ${remote}; state.serversKnown = true;
                state.servers = ${remote ? "[{id:'solo-pc',name:'Solo computer',status:'online',owner_stamp:true}]" : '[]'};
                localStorage.removeItem('coral-inbox-needs-filters');
                window.__soloWrites = []; window.__soloReads = []; window.__soloTags = ['for review'];
                const original = window.fetch;
                const json = body => Promise.resolve(new Response(JSON.stringify(body), {headers:{'Content-Type':'application/json'}}));
                window.fetch = (url, opts = {}) => {
                    const u = new URL(String(url), location.origin);
                    const target = ${remote ? "'/api/remote/solo-pc'" : "''"};
                    const p = u.pathname.startsWith(target) ? u.pathname.slice(target.length) : u.pathname;
                    const item = {id:'${'ab'.repeat(32)}',name:'Solo report.txt',team:'No team',board_id:'~no-team',available:true,media_type:'text/plain',size:12,created_at:new Date().toISOString(),produced_by:'Solo writer',session_id:'solo',tags:window.__soloTags,review_question:'Is this ready to ship?'};
                    if (p.endsWith('/comments')) return json({comments:[],you:{can_comment:true,can_lock:true},locked:false});
                    if (p === '/api/board/projects') return json([]);
                    if (${remote} && u.pathname === '/api/team-artifacts') return json({artifacts:[],has_more:false});
                    if (p === '/api/team-artifacts') { window.__soloReads.push(u.pathname); return json({artifacts:[item],has_more:false,total:1}); }
                    if (p.includes('/artifacts/') && p.endsWith('/tags')) {
                        if (opts.method === 'PUT') { window.__soloTags=JSON.parse(opts.body).tags; window.__soloWrites.push(window.__soloTags); }
                        return json({tags:window.__soloTags});
                    }
                    if (p === '/api/artifacts/${'ab'.repeat(32)}' || p === '/api/artifacts/${'ab'.repeat(32)}/raw') return Promise.resolve(new Response('Solo report content',{headers:{'Content-Type':'text/plain'}}));
                    return original(url,opts);
                };
                window.switchNavTab('hub-inbox');
                const inbox = await import((window.__coralStatic || '/static/') + 'inbox_sidebar.js');
                await inbox.openInboxGroup('needs');
            })()`);
            await waitFor(`document.querySelector('#group-table-view')?.textContent.includes('Solo report.txt')`, 'solo review row');
            assert.ok(await ev(`document.querySelector('#group-table-view').textContent.includes('Not on a team')`));
            assert.ok(await ev(`document.querySelector('#group-table-view').textContent.includes('Is this ready to ship?')`));
            assert.equal(await ev(`document.querySelectorAll('#group-table-view .inbox-main-action, #group-table-view .inbox-changes').length`), 2, 'approved no-team API supports decisions');
            await ev(`document.querySelector('#group-table-view .inbox-review-name').click(); true`);
            await waitFor(`!document.getElementById('artifact-viewer')?.hidden`, 'solo file opens');
            await waitFor(`window.__soloWrites.some(tags=>tags.includes('read'))`, 'opening marks read');
            await waitFor(`Array.from(document.querySelectorAll('.artifact-review-approve,.artifact-review-changes,.ac-toggle')).filter(e=>!e.hidden && e.getClientRects().length).length===3`, 'viewer decisions and comments available');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
