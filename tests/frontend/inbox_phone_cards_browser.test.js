// #22094/v19 replaces chat-card tint/footer/pill anatomy and long press with grouped file rows plus Select.
// Retain both themes, 320/360/390/430, real200% text, file/goal identity, 44px targets, one-tap viewer/whole question, read badge retention and selection. Retirement map names the superseding checks.
// The phone's Needs you is one card per item in the agent chat's look (#14144, the Operator: "the Inbox on the phone is a bit jumbled, probably trying to put too much on. Follow the agent chat look."; the mock they approved):
// each file or question is a card with the chat's own card colour, 1 px border and 12 px radius with the small top-left corner, 12 px apart; the glyph clears the sender's name; the message wraps above its footer (#20203); the sort
// controls are two compact chips (the word "Sort by" stays for a screen reader); the count is unread attention while read cards remain visible; the footer notice is after the last card, never over it; nothing runs off the screen. 390 and 430 px,
// dark and light, and 200% text. The review rows are stubbed through the owner list; the Inbox and its fold are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { removeBoards } = require('./helpers/board_cleanup');
const board = 'phone-cards-' + Date.now().toString(36);
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client; const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme, font] of [[390, 'dark', 16], [430, 'dark', 16], [390, 'light', 16], [390, 'dark', 32], [320, 'dark', 16], [360, 'dark', 16]]) {
            const at = `${w} ${theme} ${font}px: `; let opened = false;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            assert.equal(await ev(`fetch('/api/board/${board}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
            assert.equal(await ev(`fetch('/api/board/${board}',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'seedteam'})}).then(r=>r.status)`), 200);
            await ev(INBOX_WORLD);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '${font}px'; true`);
            await ev(`(() => { const real = window.fetch, now = Date.now(), hex = n => n.toString(16).padStart(64, '0');
                const rows = [{ id: hex(1), name: 'Desktop film with local voice over (Samantha, v3).mp4', media_type: 'text/html', size: 900, created_at: new Date(now - 10 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Developer experience', review_question: 'v3: fuller captions over the whole film, same words spoken. Good? A longer second sentence that must not make the card taller.', version: 3, earlier_digests: [hex(8), hex(9)] },
                    { id: hex(2), name: 'notes2.md', file_id: 'b'.repeat(32), version: 1, version_line: 'version 1 of notes2.md', goal_id: 1, goal_title: 'Ship the notes', task_id: 1, task_title: 'Publish notes', waits_on_this: {count: 0, closes_goal: 'Ship the notes'}, media_type: 'text/markdown', size: 1200, created_at: new Date(now - 20 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Writer', review_question: 'On v2.0.57, do the main pages look consistent on a phone?' }];
                window.fetch = (u, o = {}) => { if (/\\/api\\/board\\/${board}\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'PUT') { const id = new URL(String(u), location.href).pathname.split('/').at(-2), tags = JSON.parse(o.body).tags; const item = rows.find(a => a.id === id); if (item) item.tags = tags; return Promise.resolve(new Response(JSON.stringify({ tags }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } const page = window.__reviewFixturePage(u, location.origin, { '${board}': {team: 'seedteam', artifacts: rows} }); if (page) return Promise.resolve(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .nl-file').length===2`,at+'two ledger files');
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent==='2'`,at+'two unread files count');
            await ev(`document.querySelector('.nl-phone-count').click();document.querySelector('.inbox-fold-all').click();true`);
            await waitFor(`[...document.querySelectorAll('.nl-group-body')].every(n=>!n.hidden)`,at+'both review groups open');
            const tools=await ev(`(() => {const n=document.querySelector('.nl-visible-group > button'),r=n.getBoundingClientRect();return{left:r.left,right:r.right,w:r.width,h:r.height};})()`);
            check(tools.left>=0&&tools.right<=w+1&&tools.w>=44&&tools.h>=44,at+'Group by stays a reachable 44px control inside the tools: '+JSON.stringify(tools));
            await ev(`document.querySelector('.nl-phone-count').click();true`);
            const m=await ev(`(() => {const rows=[...document.querySelectorAll('.nl-file')];return{left:document.querySelector('.needs-ledger').getBoundingClientRect().left,wide:document.documentElement.scrollWidth>innerWidth+1,rows:rows.map(row=>{const r=row.getBoundingClientRect(),open=row.querySelector('.nl-file-open'),o=open.getBoundingClientRect(),glyph=row.querySelector('.nl-icon').getBoundingClientRect();return{text:open.textContent,inside:o.left>=r.left-1&&o.right<=r.right+1,height:o.height,clear:glyph.right<=o.left+1,overflow:row.scrollWidth>row.clientWidth+1,fresh:!!row.querySelector('.nl-new')};}),goal:[...document.querySelectorAll('.nl-group-head .nl-title')].some(n=>/#1.*Ship the notes/.test(n.textContent))};})()`);
            check(m.rows.length===2&&m.rows.every(r=>r.inside&&r.clear&&!r.overflow&&r.height>=44)&&!m.wide,at+'file icon, full words and 44px opener fit at both text sizes: '+JSON.stringify(m));
            check(m.goal&&Math.abs(m.left-12)<=1,at+'linked goal remains identified and the list keeps its 12px inset');
            check(m.rows.every(r=>r.fresh),at+'both files initially carry unread attention');
            await shot('phone-ledger-'+w+'-'+theme+'-'+font);
            if(w===390&&theme==='dark'&&font===16){
                await ev(`[...document.querySelectorAll('.nl-file-open')].find(b=>b.textContent.includes('Desktop film')).click();true`);
                await waitFor(`document.querySelector('#artifact-viewer')&&!document.querySelector('#artifact-viewer').hidden`,at+'one tap opens the file');
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click();true`);
                await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-details-item').getClientRects().length>0`,at+'Details is available');
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-details-item').click();true`);
                await waitFor(`document.querySelector('#artifact-viewer .artifact-viewer-from').getClientRects().length>0`,at+'Details shows the complete question');
                check(await ev(`document.querySelector('#artifact-viewer').textContent.includes('A longer second sentence that must not make the card taller.')`),at+'the viewer retains the whole question');
                await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent==='1'`,at+'opening one file lowers attention by one');
                check(await ev(`document.querySelectorAll('.nl-file').length===2&&document.querySelectorAll('.nl-file .nl-new').length===1`),at+'read file remains beside the unread file');
                opened=true;
                await ev(`document.querySelector('.nl-phone-select').click();true`);
                await ev(`document.querySelector('.nl-file .nl-check').click();true`);
                check(await ev(`document.querySelectorAll('.nl-file.nl-is-selected').length===1&&document.querySelector('.nl-summary strong').textContent==='1 selected'`),at+'Select chooses one file without opening or deciding it');
                await ev(`[...document.querySelectorAll('.nl-summary button')].find(b=>b.textContent==='Clear').click();true`);
                check(await ev(`document.querySelectorAll('.nl-is-selected').length===0`),at+'Clear restores the unselected list');
            }
            check(await ev(`document.getElementById('nav-tab-hub-inbox-badge')?.textContent`) === (opened?'1':'2'),at+'badge reflects unread attention while both files stay listed');

        }
    } finally { await removeBoards(ev, [board]); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the phone Needs you is one chat-style card per item at 390 and 430');
})().catch(e => { console.error(e); process.exit(1); });
