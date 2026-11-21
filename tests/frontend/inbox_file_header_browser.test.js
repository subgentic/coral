// #20297: real board IDs must resolve to names on both file tabs. A sent-back v2 file
// keeps board/time, earlier versions and the full-width You asked quote separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, nextFrame } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'b-file-' + Date.now().toString(36), label = 'release-crew', failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tr.inbox-kind-row')].find(r => r.textContent.includes(${JSON.stringify(name)}))`;
    const check = (ok, why) => { if (!ok) failures.push(why); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal(await ev(`fetch('/api/board/${board}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
            assert.equal(await ev(`fetch('/api/board/${board}',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'${label}'})}).then(r=>r.status)`), 200);
            await ev(`(async () => {
                localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral-inbox-needs-tab');
                const base = window.__coralStatic || '/static/';
                (await import(base + 'server_base.js')).noteBoardLabels([{ board_project: '${board}', board_label: '${label}' }]);
                const state = (await import(base + 'state.js')).state;
                state.liveSessions = [{session_id:'file-writer',name:'Writer',display_name:'Writer',agent_type:'claude',board_project:'${board}',board_label:'${label}',working:false}];
                const item = (i, name, sent, version = 1) => ({ id:i.toString(16).padStart(64,'0'), name, media_type:'text/markdown', size:30, created_at:new Date(Date.now()-i*60000).toISOString(), source:'upload', available:true, session_id:'file-writer', produced_by:'Writer', tags:sent?['for review','changes requested']:['for review'], file_id:name.replace(/\\W/g,'').padEnd(32,'0'), version, versions:version, version_line:'version '+version+' of '+name, ...(sent?{review:{state:'changes requested',at:new Date().toISOString()}}:{}) });
                window.__fileRows = [item(1,'Ready report.md',false),item(2,'Ready plan.md',false,2),item(3,'Sent report.md',true),item(4,'Sent plan.md',true,2)];
                const original = window.fetch, json = body => Promise.resolve(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}));
                window.fetch = (url, opts = {}) => {
                    const u = new URL(String(url),location.href), page = u.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(u,location.href,{'${board}':{team:'${label}',artifacts:window.__fileRows}}) : null;
                    if (page) return json(page);
                    const normal = window.__reviewFixtureURL(String(url),location.origin);
                    if (normal.pathname === '/api/board/${board}/artifacts') return json({project:'${board}',artifacts:window.__fileRows,has_more:false});
                    if (u.pathname === '/api/waiting-on-agent') return json({items:[]});
                    if (/[/]api[/]artifacts[/][0-9a-f]{64}[/]comments$/.test(u.pathname)) return json({comments:[{id:1,parent_id:null,anchor:{whole:true},body:'Changes requested: Please move it to Friday',mine:true,author:{kind:'owner',name:'You'},created_at:new Date().toISOString()}],you:{kind:'owner',can_comment:true,can_lock:true},locked:false});
                    if (u.pathname === '/api/settings' && opts.method === 'PUT') return json({ok:true});
                    return original(url,opts);
                }; return true;
            })()`);
            await ev(`window.switchNavTab('hub-inbox');true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
            for (const tab of ['you','agent']) {
                await ev(`document.querySelector('[data-needs-tab="${tab}"]').click();true`);
                const names = tab === 'you' ? ['Ready report.md','Ready plan.md'] : ['Sent report.md','Sent plan.md'];
                await waitFor(`!!(${row(names[0])}) && !!(${row(names[1])})`, 'both file versions on '+tab, 15000);
                if (tab === 'agent') await waitFor(`(${row(names[1])}).querySelector('.inbox-sent-back-ask')?.textContent.includes('Friday')`, 'the actual You asked quote', 10000);
                const info = await ev(`(() => { return ${JSON.stringify(names)}.map(name => { const tr = ${row('PLACEHOLDER').replace('"PLACEHOLDER"','name')}, it = tr.querySelector('.inbox-review-item'), r = it.getBoundingClientRect(), board = tr.querySelector('.inbox-header-board'), quote = it.querySelector('.inbox-sent-back-ask'), q = quote?.getBoundingClientRect(); const kids = [...it.children].flatMap(c => (getComputedStyle(c).display === 'contents' || c.classList.contains('inbox-header-meta')) ? [...c.children] : [c]).filter(c => getComputedStyle(c).position !== 'absolute' && c.getBoundingClientRect().width && c.getBoundingClientRect().height); const header = [...it.querySelectorAll('.inbox-review-from, .inbox-header-board, .inbox-header-meta .inbox-review-wait, .inbox-review-tags .inbox-review-earlier, .inbox-review-tags .inbox-review-version')].map(n => { const range = document.createRange(); range.selectNodeContents(n); return {name:n.className,r:n.classList.contains('inbox-header-board') ? n.getBoundingClientRect() : range.getBoundingClientRect()}; }).filter(n=>n.r.width&&n.r.height); const headerClashes=[]; for(let a=0;a<header.length;a++)for(let b=a+1;b<header.length;b++){const x=header[a].r,y=header[b].r;if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>2&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>2)headerClashes.push(header[a].name+' x '+header[b].name);} const clashes = []; for(let a=0;a<kids.length;a++)for(let b=a+1;b<kids.length;b++){const x=kids[a].getBoundingClientRect(),y=kids[b].getBoundingClientRect();if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>2&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>2)clashes.push(kids[a].className+' x '+kids[b].className);} return {name,board:board?.textContent||'',text:tr.textContent,quoteWidth:q?.width,itemWidth:r.width,quoteLeft:q?.left,itemLeft:r.left,clashes,headerClashes}; }); })()`);
                for (const v of info) {
                    check(width === 390 ? v.board === label : v.text.includes(label), width+' '+tab+' '+v.name+' resolves board name: '+JSON.stringify(v));
                    if (width === 390 && tab === 'agent') {
                        check(!v.clashes.length && !v.headerClashes.length, '390 '+v.name+' no header/quote overlap: '+JSON.stringify(v));
                        check(v.quoteWidth >= v.itemWidth - 2 && Math.abs(v.quoteLeft-v.itemLeft)<=1, '390 '+v.name+' full-width You asked: '+JSON.stringify(v));
                    }
                }
                if (width === 390 && tab === 'agent') check(info[1].text.includes('1 earlier version') && info[1].text.includes('v2'), 'two-version fixture actually renders v2 and 1 earlier version');
                if (process.env.CORAL_SCREENSHOT_DIR) for (const theme of ['light','dark']) {
                    await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`);
                    await nextFrame(ev);
                    fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});
                    fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/file-header-'+width+'-'+tab+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
                }
            }
        }
        assert.deepEqual(failures, [], failures.join('\n'));
        console.log('PASS file board names and versioned sent-back phone geometry');
    } finally { await removeBoards(ev,[board]); await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
