// #14033: Hub Needs you owns one done-goal row per computer/board/id. Actions never fall back to the Hub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const row = source => `document.querySelector('${T} tr[data-key^="${source}:goal_done:"]')`;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 1000, mobile: false, inbox: 'native', needs: true, hubPages: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const original = window.fetch, json = (body, status = 200) => Promise.resolve(Response.json(body, { status }));
            window.__goalOwner = true; window.__goalWrites = []; window.__localGoalWrites = [];
            window.__remoteDone = JSON.parse(sessionStorage.getItem('hub-done-goals') || 'null') || Object.fromEntries(['m1','m2'].map(server => [server, { id:7, board_id:'same-team', board_label:'Release team', title:'Ship on '+server, state:'active', done_when:'The release ships', created_by:'Operator', driver:'Dev', created_at:'2026-11-01T00:00:00Z', updated_at:'2026-11-01T00:00:00Z', looks_done_at:'2026-11-01T00:00:00Z', rollup:{active:0,blocked:0,queued:0,done:1,total:1} }]));
            window.fetch = (input, options = {}) => {
                const url = new URL(String(input), location.href), method = options.method || 'GET';
                if (method !== 'GET' && url.pathname.startsWith('/api/board/')) window.__localGoalWrites.push(url.pathname);
                const parts = url.pathname.split('/'), source = parts[3];
                if (parts[1] !== 'api' || parts[2] !== 'remote' || !['m1','m2'].includes(source)) return original(input, options);
                const path = '/' + parts.slice(4).join('/'), goal = window.__remoteDone[source];
                if (path === '/api/goals') return json({goals: goal.state === 'active' ? [goal] : []});
                if (path === '/api/board/same-team/goals/7/done-state' && method === 'POST') {
                    const body = JSON.parse(options.body); window.__goalWrites.push({source,path,body});
                    if (!window.__goalOwner) return json({error:'owner_only'},403);
                    const next = {...goal.done_state};
                    if (body.state === 'dismiss' || body.state === 'not_yet') next.hidden = body.state === 'dismiss' ? 'dismissed' : 'not_yet';
                    else if (body.state === 'show') delete next.hidden;
                    else if (body.state === 'read') next.read = true;
                    else if (body.state === 'unread') delete next.read;
                    goal.done_state = next; sessionStorage.setItem('hub-done-goals',JSON.stringify(window.__remoteDone));
                    return json({ok:true});
                }
                if (path === '/api/board/same-team/goals/7/close' && method === 'POST') {
                    const body = JSON.parse(options.body); window.__goalWrites.push({source,path,body});
                    if (!window.__goalOwner) return json({error:'owner_only'},403);
                    goal.state = body.state; return json({goal});
                }
                if (path === '/api/board/same-team/goals/7') return json({goal});
                if (path === '/api/board/same-team/goals') return json({goals:[goal]});
                if (path === '/api/board/same-team/settings') return json({require_goal:false});
                if (path.endsWith('/comments')) return json({comments:[],you:{can_comment:window.__goalOwner},locked:false});
                if (path.endsWith('/tasks')) return json({tasks:[],total:0,has_more:false});
                return original(input, options);
            };
        })()` });
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width<760});
            await Emulation.setTouchEmulationEnabled({enabled:width<760});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await coralReady(ev,'startup','settings');
            await ev(`window.switchNavTab('hub-inbox'); import(${S}+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
            await waitFor(`!!(${row('m1')}) && !!(${row('m2')})`, width+': equal goal ids from both computers appear',8000);
            const keys = await ev(`[...document.querySelectorAll('${T} tr[data-key*="goal_done:"]')].map(r=>r.dataset.key)`);
            assert.equal(new Set(keys).size,2,'source-qualified goal row identities');
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/hub-goals-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); }
            const action = async label => {
                if (width >= 760) { await ev(`(${row('m2')}).querySelector('button[aria-label^="${label}"]').click();true`); return; }
                const point = await ev(`(()=>{const r=(${row('m2')});r.scrollIntoView({block:'center'});const b=r.getBoundingClientRect();return{x:b.left+b.width*.35,y:b.top+b.height*.5};})()`);
                await client.Input.dispatchTouchEvent({type:'touchStart',touchPoints:[{...point,id:1}]});
                await new Promise(resolve=>setTimeout(resolve,700)); // sleep-ok: a long press is a held finger
                await client.Input.dispatchTouchEvent({type:'touchEnd',touchPoints:[]});
                await waitFor(`/1 selected/.test(document.querySelector('.dt-bar')?.textContent||'')`, 'phone goal selection');
                if (label !== 'Dismiss') await ev(`document.querySelector('.dt-bar [aria-label="More actions"]').click();true`);
                await waitFor(`!![...document.querySelectorAll('.dt-bar button,.menu-item,[role=menuitem]')].find(b=>(b.getAttribute('aria-label')||b.textContent).trim()==='${label}')`, 'phone goal action');
                await ev(`[...document.querySelectorAll('.dt-bar button,.menu-item,[role=menuitem]')].find(b=>(b.getAttribute('aria-label')||b.textContent).trim()==='${label}').click();true`);
            };
            const undo = async () => { await waitFor(`!![...document.querySelectorAll('.toast button')].find(b=>b.textContent.trim()==='Undo')`,'Undo available'); await ev(`[...document.querySelectorAll('.toast button')].find(b=>b.textContent.trim()==='Undo').click();true`); await waitFor(`!!(${row('m2')})`,'source goal restored'); };
            await action('Not yet'); await waitFor(`!(${row('m2')}) && !!(${row('m1')})`,'Not yet hides only Desktop goal'); await undo();
            await action('Dismiss'); await waitFor(`!(${row('m2')}) && !!(${row('m1')})`,'Dismiss hides only Desktop goal'); await undo();
            const sent = await ev(`window.__goalWrites.filter(w=>w.path.endsWith('/done-state'))`);
            assert.deepEqual(sent.map(w=>[w.source,w.body.state]),[['m2','not_yet'],['m2','show'],['m2','dismiss'],['m2','show']]);
            await ev(`window.__goalOwner=false;true`); await action('Not yet');
            await waitFor(`/403/.test(document.body.textContent)`,'non-owner refusal is stated');
            assert.equal(await ev(`!!(${row('m2')}) && !!(${row('m1')})`),true,'refused write does not hide either goal');
            await ev(`window.__goalOwner=true;true`);
            const reloadNeeds = async () => {
                await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await coralReady(ev,'startup','settings');
                await ev(`window.switchNavTab('hub-inbox'); import(${S}+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${row('m1')})`,'other computer remains after reload');
            };
            for (const label of ['Not yet','Dismiss']) {
                await action(label); await waitFor(`!(${row('m2')})`,'hidden before reload');
                await reloadNeeds();
                assert.equal(await ev(`!!(${row('m2')})`),false,label+' remains hidden after full reload');
                await ev(`import(${S}+'server_base.js').then(m=>m.serverFetch('m2','/api/board/same-team/goals/7/done-state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'show'})})).then(()=>true)`);
                await reloadNeeds(); await waitFor(`!!(${row('m2')})`,'source show restores row after reload');
            }
            await ev(`(${row('m2')}).click();true`);
            await waitFor(`window.__goalWrites.some(w=>w.source==='m2'&&w.body.state==='read')`,'opening marks source read');
            await reloadNeeds(); await waitFor(`(${row('m2')})?.classList.contains('dt-read')`,'source read survives reload');
            assert.equal(await ev(`(${row('m1')}).classList.contains('dt-read')`),false,'other computer stays unread');
            await action('Close goal'); await waitFor(`!!document.querySelector('dialog.goals-close-dialog[open]')`,'remote close dialog');
            await ev(`document.querySelector('dialog.goals-close-dialog form').requestSubmit();true`);
            await waitFor(`window.__goalWrites.some(w=>w.source==='m2'&&w.path.endsWith('/close'))`,'Close goal uses Desktop');
            assert.equal(await ev(`window.__remoteDone.m2.state`),'done'); assert.equal(await ev(`window.__remoteDone.m1.state`),'active');
            assert.deepEqual(await ev(`window.__localGoalWrites`),[],'no write falls back to the Hub/local board');
            await ev(`sessionStorage.removeItem('hub-done-goals');true`);
        }
        console.log('PASS Hub done-goal rows and source-scoped actions on desktop/phone, with non-owner refusal');
    } catch (error) { console.error('Hub goal diagnostics:', await ev(`JSON.stringify({goals:window.__remoteDone,requests:window.__remoteRequests,rows:[...document.querySelectorAll('#group-table-view tr')].map(r=>({key:r.dataset.key,text:r.textContent})),body:document.body.innerText.slice(-3000)})`)); throw error; } finally { await client.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
