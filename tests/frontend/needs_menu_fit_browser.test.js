// #12696 also checks hit targets beyond every clipping ancestor, not only viewport bounds.
// A row's ⋯ menu on Needs you opens where its dots are (#12383, QA Reviewer 2's find on #12231): the rule that makes the dots' wrapper the menu's anchor (position: relative) lived in the team page's stylesheet, which is not loaded
// when the Inbox is the first page, so on a phone the menu was anchored to the whole main stage, 242 px off to the right, and opening it scrolled the page sideways to reach it (the stage was 632 px wide in a 390 px window).
// 1280 and 390 px: the stage fits its window before and after, its scroll position stays 0, the dots' wrapper is the anchor and the whole menu is on the screen.
// The actions of a Needs you review row, option B (#12231, the operator: "We can do better with these buttons", then "I like option B, let's use Dismiss instead of the word Ignore"): one Approve button; Request changes and Save for later as
// quiet icons of one size, named for the file; the three dots hold Approve with a note, Dismiss and Deny (Deny in the error colour, never a red fill); the word Ignore is nowhere on the row, in its menu or in the toast, which says Dismissed
// with Undo. A button is at the same x on every row; on a phone every target is 44 px. 1280 and 390 px; review files and a question stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'b-' + Date.now().toString(36), T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, font] of [[1280, 800, false, 16], [1280, 800, false, 32], [390, 844, true, 16]]) {
            const at = `${w} px, ${font}px text: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`document.documentElement.style.fontSize='${font}px';true`);
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const hex = n => n.toString(16).padStart(64, '0'), ago = m => new Date(Date.now() - m * 60000).toISOString(); const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.__posts = []; const items = [1, 2, 3].map(i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 3000, created_at: ago(30 + i), source: 'upload', available: true, tags: ['for review'], uploader: 'Writer', produced_by: 'Writer' }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                    if (method === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    if (method === 'POST' && /\\/artifacts\\/[0-9a-f]{64}\\/review$/.test(u.pathname)) { const b = JSON.parse(opts.body); window.__posts.push(b.decision); const it = items.find(a => u.pathname.includes(a.id)); if (b.decision === 'ignore') it.tags = ['for review', 'ignored']; return json({ id: it.id, state: b.decision, changed: true, tags: it.tags, delivered: false }); }
                    if (u.pathname === '/api/operator-asks') return json([{ board: '${team}', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: ago(20) }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`(() => { const original=window.fetch; window.fetch=(u,o={})=> /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({messages:[],total:0,prompt_options:{ask_id:'clip-ask',question:'Proceed?',options:[{n:1,label:'Yes, proceed (y)',action:'select'},{n:2,label:'No, and tell Codex what to do differently (esc)',action:'select'}]}}),{headers:{'content-type':'application/json'}})) : original(u,o); const entry=window.__m.entry.bind(window.__m); window.__m.entry=a=>({...entry(a),waiting_for_input:true,waiting_kind:'permission',waiting_summary:'Proceed?',waiting_since:new Date().toISOString()}); window.__m.add('clip-agent','clip',1,{sleeping:false,board_project:'${team}',session_id:'clip-agent'}); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 5`, at + 'three reviews, a prompt and a question', 15000); await ev(framesJs(6));
            const one = `[...document.querySelectorAll('${T} tbody tr')].find(r => /plan-3/.test(r.textContent))`;
            const ms = `document.getElementById('main-stage')`;
            await waitFor(`document.querySelectorAll('${T} .inbox-answer').length === 2`, at+'prompt choices');
            await shot(`answers-${w}-${font}`);
            const clipped = await ev(`(() => { const bad=[]; for(const b of document.querySelectorAll('${T} .inbox-answer')) { const r=b.getBoundingClientRect(); for(let e=b.parentElement;e;e=e.parentElement){const c=getComputedStyle(e),q=e.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(c.overflowX) && (r.left<q.left-1 || r.right>q.right+1))bad.push(b.textContent+' clipped by '+e.className);if(/hidden|clip|auto|scroll/.test(c.overflowY) && (r.top<q.top-1 || r.bottom>q.bottom+1))bad.push(b.textContent+' vertically clipped by '+e.className);} } return bad; })()`);
            failures.push(...clipped.map(x=>at+x));

            assert.ok(await ev(`${ms}.scrollWidth <= ${ms}.clientWidth`), `${w}: the main stage fits its window before the menu opens`);
            await ev(`${one}.querySelector('.inbox-row-more-toggle').focus(); true`); await ev(framesJs(3)); // a phone's row shows its buttons while the keyboard is in them: the dots are focused before they are pressed
            await ev(`${one}.querySelector('.inbox-row-more-toggle').click(); true`); await ev(framesJs(6));
            const after = await ev(`(() => { const ms = document.getElementById('main-stage'), menu = document.querySelector('.inbox-row-more .menu:not([hidden])'), r = menu.getBoundingClientRect(), wrap = menu.parentElement; return { sw: ms.scrollWidth, cw: ms.clientWidth, left: ms.scrollLeft, wrapPos: getComputedStyle(wrap).position, menu: [Math.round(r.left), Math.round(r.right), Math.round(r.top), Math.round(r.bottom)], vw: innerWidth, vh: innerHeight }; })()`);
            assert.ok(after.wrapPos === 'relative' && after.left === 0 && after.sw <= after.cw, `${w}: opening a row's menu does not scroll the page sideways (the menu hangs from its dots): ` + JSON.stringify(after));
            assert.ok(after.menu[0] >= 0 && after.menu[1] <= after.vw && after.menu[2] >= 0 && after.menu[3] <= after.vh, `${w}: the whole menu is on the screen: ` + JSON.stringify(after));
            await shot(`menu-${w}-${font}`);
            const targets=await ev(`(() => { const m=document.querySelector('.inbox-row-more .menu:not([hidden])'); window.__menuClicks=[]; m.addEventListener('click',e=>{const b=e.target.closest('[role=menuitem]');if(b){window.__menuClicks.push(b.textContent);e.stopImmediatePropagation();}},true); return [...m.querySelectorAll('[role=menuitem]')].map(b=>{const r=b.getBoundingClientRect(), x=r.left+r.width/2,y=r.top+r.height/2;return {text:b.textContent,x,y,hit:b.contains(document.elementFromPoint(x,y))};}); })()`);
            for(const target of targets){
                if(!target.hit) failures.push(at+target.text+' is clipped or covered');
                await client.Input.dispatchMouseEvent({type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1});
                await client.Input.dispatchMouseEvent({type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1});
            }
            const clicked=await ev('window.__menuClicks');
            if(JSON.stringify(clicked)!==JSON.stringify(targets.map(t=>t.text)))failures.push(at+'not every menu item received a real pointer click: '+JSON.stringify(clicked));
            await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
            await waitFor(`!document.querySelector('.inbox-row-more-toggle[aria-expanded="true"]')`,at+'Escape closes the menu');
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    assert.deepEqual(failures, [], 'Menus and prompt choices escape clipping: '+failures.join('; '));
    console.log('needs_menu_fit_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
