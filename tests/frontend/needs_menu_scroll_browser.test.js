// #12951: a last-row Needs you menu floats above the bottom edge without changing
// row positions, table height, or any ancestor scroll position. Desktop and phone.
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
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`(() => { const real = window.fetch; window.__goals = Array.from({length:24}, (_,i) => ({id:i+1, board_id:'team-a', title:'Completed goal '+(i+1), state:'active', rollup:{done:2}, updated_at:'2026-11-01T00:00:00Z'})); window.fetch = (u,o={}) => new URL(String(u),location.origin).pathname === '/api/goals' ? Promise.resolve(new Response(JSON.stringify({goals:window.__goals}),{headers:{'content-type':'application/json'}})) : real(u,o); T.state.settings.goal_done_read = JSON.stringify(window.__goals.map(g=>'team-a|'+g.id+'|2|'+g.updated_at)); T.state.liveSessions=[]; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
            await waitFor(`document.querySelectorAll('.inbox-goaldone-actions .inbox-row-more-toggle').length === 24`, 'read goal menus');
            await ev(`window.__toggle=[...document.querySelectorAll('.inbox-goaldone-actions .inbox-row-more-toggle')].at(-1); __toggle.focus({preventScroll:true}); __toggle.scrollIntoView({block:'end'}); true`);
            await ev(framesJs(2));
            const measure = `(() => { const t=__toggle.closest('table'), rows=[...t.rows].map(r=>r.getBoundingClientRect().top), scroll=[]; for(let e=__toggle.parentElement;e;e=e.parentElement) scroll.push([e.tagName,e.id,e.scrollTop,e.scrollHeight]); const b=t.getBoundingClientRect(); return {rows,scroll,height:b.height}; })()`;
            const before = await ev(measure);
            await shot(`closed-${width}`);
            await ev(`__toggle.click(); true`);
            await waitFor(`__toggle.getAttribute('aria-expanded')==='true'`, 'menu open');
            await ev(framesJs(2));
            const after = await ev(measure);
            const menu = await ev(`(() => {const m=document.getElementById(__toggle.getAttribute('aria-controls')),r=m.getBoundingClientRect(),t=__toggle.getBoundingClientRect();return {position:getComputedStyle(m).position,top:r.top,bottom:r.bottom,left:r.left,right:r.right,above:r.bottom<=t.top,hit:m.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`);
            await shot(`open-${width}`);
            console.log(width, JSON.stringify({before,after,menu}));
            if(JSON.stringify(before)!==JSON.stringify(after)) failures.push(`${width}: opening moved rows or scroll: ${JSON.stringify({before,after})}`);
            if(menu.position!=='fixed'||!menu.above||!menu.hit||menu.top<0||menu.bottom>height||menu.left<0||menu.right>width) failures.push(`${width}: menu must float upward and be reachable: ${JSON.stringify(menu)}`);
            await ev(`import((window.__coralStatic||'/static/')+'menu_button.js').then(m=>m.closeMenus({restoreFocus:true})).then(()=>true)`);
            await ev(framesJs(2));
            assert.deepEqual(await ev(measure), before, 'closing restores the same rows and scroll');
        }
        assert.deepEqual(failures, [], failures.join('\n'));
        console.log('PASS needs_menu_scroll_browser');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
