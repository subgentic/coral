// #12951: a last-row Needs you menu floats above the bottom edge without changing
// row positions, list height, or any ancestor scroll position. Desktop and phone.
// #22094: the list is the Needs you ledger (needs_ledger.js): 24 files and 24 Goal looks done rows (article.nl-row, data-needs-key goal_done:) in the folded 'Not tied to a goal' group, opened here
// (the list shows ten of one producer's files, the rest behind 'Writer: 14 more for review').
// A row's menu is details.nl-more > summary.nl-more-toggle + .nl-menu, drawn on a phone / coarse pointer; a desktop row has hover actions instead, so the menu half runs at 390.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: "try { localStorage.setItem('coral-alerts-offered', '1'); } catch (e) {}" }); // the alerts offer shows 1 to 8 s after launch, once the page is still, and its 49 px strip moved every row between 'before' and 'closed' on a slow runner (#20778): this page is measured without it, as other layout suites do
        for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`(() => { const real = window.fetch, json = b => Promise.resolve(Response.json(b)); window.__goals = Array.from({length:24}, (_,i) => ({id:i+1, board_id:'team-a', title:'Completed goal '+(i+1), state:'active', rollup:{done:2}, updated_at:'2026-11-01T00:00:00Z'}));
                const reviews=Array.from({length:24},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:'Review '+(i+1)+'.md',produced_by:'Writer',available:true,media_type:'text/markdown',size:20,tags:['for review'],review_question:'Review this note?',created_at:new Date(Date.now()-i*60000).toISOString()}));
                window.fetch=(u,o={})=>{const path=new URL(String(u),location.origin).pathname;if(path==='/api/goals')return json({goals:window.__goals});if(path==='/api/team-artifacts')return json(window.__reviewFixturePage(u,location.origin,{'team-a':reviews}));return real(u,o);};
                T.state.settings.goal_done_read=JSON.stringify(window.__goals.map(g=>'team-a|'+g.id+'|2|'+g.updated_at));T.state.liveSessions=[];return true;})()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
            const GD = `.needs-ledger .nl-row[data-needs-key*="goal_done:"]`;
            await waitFor(`document.querySelectorAll('${GD} .nl-actions button').length >= 24 && document.querySelectorAll('.needs-ledger .nl-file').length >= 10`, 'read goal rows').catch(async e=>{throw new Error(e.message+' '+JSON.stringify(await ev(`({goals:document.querySelectorAll('${GD}').length,files:document.querySelectorAll('.needs-ledger .nl-file').length,text:document.getElementById('group-table-view').innerText.slice(-1500)})`)))});
            await ev(`document.querySelectorAll('.needs-ledger .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`); // the group holds no question, so it starts folded
            // #19300: scrolling the last of 24 goal rows into view froze the page for 17 s (each row loaded team_uncommitted.js and drew the whole list again: 2112 folder-list draws): the page must stay responsive
            await ev(`window.__busy = 0; window.__obs = new PerformanceObserver(l => l.getEntries().forEach(e => { __busy += e.duration; })); __obs.observe({ entryTypes: ['longtask'] }); true`);
            await ev(`window.__toggle=[...document.querySelectorAll('${GD} .nl-actions button')].filter(b=>!b.hidden).at(-1); __toggle.focus({preventScroll:true}); __toggle.scrollIntoView({block:'end'}); true`);
            await ev(framesJs(2));
            await ev(framesJs(2));
            await ev(`__obs.takeRecords().forEach(e => { __busy += e.duration; }); true`);
            assert.ok(await ev('__busy') < 2000, `${width}: scrolling to the last goal row blocked the page for ${await ev('Math.round(__busy)')} ms`);
            // the row menu (details.nl-more) is drawn for a coarse pointer or a phone only: a desktop row's actions are its hover buttons (.nl-hover-actions), so at 1280 there is no menu to open (by design, needs_ledger.css)
            if (!mobile) { assert.equal(await ev(`[...document.querySelectorAll('.needs-ledger .nl-more')].filter(d=>d.getClientRects().length).length`), 0, '1280: no row menu on a desktop'); continue; }
            // Scrolling may redraw rows; acquire the connected last-row control.
            await ev(`window.__toggle=[...document.querySelectorAll('.needs-ledger .nl-row .nl-more-toggle')].filter(t=>t.getClientRects().length).at(-1); window.__details=__toggle.closest('details'); __toggle.scrollIntoView({block:'end'}); __toggle.focus({preventScroll:true}); true`);
            const measure = `(() => { const t=__toggle.closest('.needs-ledger'), rows=[...t.querySelectorAll('.nl-row,.nl-group-head')].map(r=>r.getBoundingClientRect().top), scroll=[]; for(let e=__toggle.parentElement;e;e=e.parentElement) scroll.push([e.tagName,e.id,e.scrollTop,e.scrollHeight]); const b=t.getBoundingClientRect(); return {rows,scroll,height:b.height}; })()`;
            const before = await ev(measure);
            await shot(`closed-${width}`);
            await ev(`__toggle.click(); true`);
            await waitFor(`__details.open`, 'menu open '+width).catch(async e=>{throw new Error(e.message+' '+JSON.stringify(await ev(`({connected:__toggle.isConnected,open:__details.open,rect:__toggle.getBoundingClientRect().toJSON()})`)));});
            await ev(framesJs(2));
            const after = await ev(measure);
            const menu = await ev(`(() => {const m=__details.querySelector('.nl-menu'),r=m.getBoundingClientRect(),t=__toggle.getBoundingClientRect();return {position:getComputedStyle(m).position,top:r.top,bottom:r.bottom,left:r.left,right:r.right,above:r.bottom<=t.top,hit:m.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`);
            await shot(`open-${width}`);
            console.log(width, JSON.stringify({before,after,menu}));
            if(JSON.stringify(before)!==JSON.stringify(after)) failures.push(`${width}: opening moved rows or scroll: ${JSON.stringify({before,after})}`);
            if(!menu.above||!menu.hit||menu.top<0||menu.bottom>height||menu.left<0||menu.right>width) failures.push(`${width}: menu must float upward and be reachable: ${JSON.stringify(menu)}`);
            await ev(`__details.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
            await ev(framesJs(2));
            assert.equal(await ev('__details.open'), false, 'Escape closes the menu');
            assert.deepEqual(await ev(measure), before, 'closing restores the same rows and scroll');
        }
        assert.deepEqual(failures, [], failures.join('\n'));
        console.log('PASS needs_menu_scroll_browser');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
