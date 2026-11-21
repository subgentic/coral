// #20203: v4 message boxes and one footer per kind, both tabs, 1280/390 and both themes.
// Also covers an agent-only phone list, which uses the shared mail renderer.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'hover-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const checkFooterOrder = async label => {
        const rows = await ev(`(() => [...document.querySelectorAll('${T} .inbox-v4-footer')].map(f=>{const bs=[...f.querySelectorAll('button')].filter(b=>b.getClientRects().length&&getComputedStyle(b).visibility!=='hidden'),more=bs.find(b=>b.matches('.inbox-row-more-toggle'));return {types:bs.map(b=>b.matches('.inbox-bookmark')?'Save':b.matches('.inbox-review-star')?'Star':b.matches('.inbox-row-more-toggle')?'More':b.textContent.trim()),rightmost:!more||bs.every(b=>b===more||b.getBoundingClientRect().right<=more.getBoundingClientRect().left+1),hasMore:!!more};}))()`);
        for(const r of rows.filter(r=>r.hasMore)){check(r.rightmost&&r.types.at(-1)==='More',label+' More is rightmost in geometry and keyboard order: '+JSON.stringify(r));const common=r.types.filter(t=>['Save','Star','More'].includes(t));check(common.join(',')===(common.includes('Save')?'Save,':'')+(common.includes('Star')?'Star,':'')+'More',label+' common controls follow Save, Star, More: '+JSON.stringify(r));}
    };

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1280, 1000, false], [390, 1100, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?', waits_on_this: i===1 ? {count:0,closes_goal:'Footer goal'} : null });
                const items = [item(1, ['for review']), item(2, ['for review', 'read']), item(3, ['for review']), {...item(4, ['for review', 'changes requested']), name:'report.md',produced_by:'Writer',session_id:'writer-asleep',review_question:'',goal_id:987,goal_title:'Footer goal',task_id:17,task_title:'Add breakdown'}];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    if (u.pathname === '/api/goals') return json({goals: [{id:987, board_id:'${team}', title:'Footer goal', state:'active', updated_at:new Date(Date.now()-3600000).toISOString(), rollup:{done:1,active:0,blocked:0,queued:0}}]});
                    if (u.pathname === '/api/sessions/live/be/chat') return json({messages:[],total:0,prompt_options:{question:'Do you want to proceed?',ask_id:'footer-permission',target:'git status --short',options:[{n:1,label:'Yes',action:'select'},{n:2,label:'No',action:'select'}]}});
                    if (u.pathname === '/api/sessions/live/qa/chat') return json({messages:[],total:0,prompt_options:{question:'Pick a color',ask_id:'footer-live-question',options:[{n:1,label:'Red',action:'select'},{n:2,label:'Blue',action:'select'}]}});
                    if (u.pathname.startsWith('/api/artifacts/') && u.pathname.endsWith('/comments')) return json({comments:[{id:7,parent_id:null,anchor:{whole:true},body:'Changes requested: Can we add the 390 px breakdown and group totals by team?',mine:true,author:{kind:'owner',name:'You'},created_at:new Date().toISOString()}],you:{kind:'owner',can_comment:true,can_lock:true},locked:false});
                    return original(url, opts); };
                return true; })()`);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify([{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which release day?\\n1. Monday is possible.\\n2. Friday has a wider testing window.\\n3. Confirm the release owner.\\n4. Check the backup plan.\\n5. LAST-LINE: keep the complete numbered question available.', buttons: [{id:1,label:'Monday',action:'reply',state:'pending'},{id:2,label:'Friday',action:'reply',state:'pending'}], at: new Date(Date.now() - 300000).toISOString() }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`import(${S}+'state.js').then(({state})=>{state.liveSessions=[{name:'Writer',session_id:'writer-asleep',display_name:'Writer',agent_type:'claude',server:'local',status:'idle',board_project:'${team}',sleeping:true,last_timestamp:new Date(Date.now()-7200000).toISOString()}, {name:'be',session_id:'footer-permission-agent',display_name:'Backend Dev',agent_type:'claude',server:'local',status:'idle',board_project:'${team}',waiting_for_input:true,waiting_kind:'permission',waiting_summary:'Claude needs your permission',working_directory:'/work/dir',waiting_since:new Date(Date.now()-240000).toISOString()}, {name:'qa',session_id:'footer-live-question-agent',display_name:'Question Agent',agent_type:'claude',server:'local',status:'idle',board_project:'${team}',waiting_for_input:true,waiting_kind:'question',waiting_summary:'Wants to know: Pick a color',working_directory:'/work/dir',waiting_since:new Date(Date.now()-180000).toISOString()}];return true;})`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3 && !!document.querySelector('${T} tbody tr .inbox-answers, ${T} tbody tr [data-on-click*="ask"], ${T} tbody tr button')`, at + 'the review rows and the question', 15000);
            await waitFor(`!!document.querySelector('${T} .inbox-answer') && [...document.querySelectorAll('${T} tbody tr')].some(r=>r.textContent.includes('Footer goal'))`, 'permission answers and goal row', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
            for (const theme of ['dark', 'light']) {
                await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`); await ev(framesJs(3));
                const info = await ev(`(() => { const visible = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden'; return [...document.querySelectorAll('${T} tbody tr.inbox-kind-row')].map(tr => {
                    const title = tr.querySelector('.inbox-review-name, .dt-person'), actions = tr.querySelector('[data-key="review"]'), buttons = actions ? [...actions.querySelectorAll('button')].filter(visible) : [], rect = n => { const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}; };
                    const decisions = buttons.filter(b => !b.closest('.inbox-row-more') && !b.matches('.inbox-bookmark,.inbox-review-star'));
                    const common = buttons.filter(b => b.closest('.inbox-row-more') || b.matches('.inbox-bookmark,.inbox-review-star'));
                    const headingNode=tr.querySelector('.inbox-v4-heading'),headingText=headingNode&&document.createTreeWalker(headingNode,NodeFilter.SHOW_TEXT).nextNode(),range=document.createRange(); if(headingText)range.selectNodeContents(headingText); return {runtimeDots:[...tr.querySelectorAll('.inbox-question-runtime > .inbox-meta-dir')].map(n=>getComputedStyle(n,'::before').content),headingInk:headingText&&rect({getBoundingClientRect:()=>range.getBoundingClientRect()}),heading:tr.querySelector('.inbox-v4-heading')&&rect(tr.querySelector('.inbox-v4-heading')),icon:tr.querySelector('.inbox-kind-icon')&&rect(tr.querySelector('.inbox-kind-icon')),implied:[...tr.querySelectorAll('.inbox-implied-intro')].map(n=>({text:n.textContent,clip:getComputedStyle(n).clipPath,...rect(n)})),commandHeader:!!tr.querySelector('.inbox-command-meta'),kind:tr.querySelector('.inbox-kind-icon')?.dataset.kind, metadata:[...tr.querySelectorAll('.inbox-meta')].map(rect), messageTexts:[...tr.querySelectorAll('.inbox-message')].map(m=>m.textContent),messages:[...tr.querySelectorAll('.inbox-message')].map(rect), footer:actions && {cls:actions.className, grid:getComputedStyle(actions).gridColumn, order:getComputedStyle(actions).order, display:getComputedStyle(actions).display}, text:tr.textContent.slice(0,60), title:title&&rect(title), row:rect(tr), decisions:decisions.map(b=>({text:b.textContent.trim(),...rect(b)})), common:common.map(b=>({text:b.textContent.trim(),isMore:b.matches('.inbox-row-more-toggle'),...rect(b)}))};
                }); })()`);
                check(['review','ask','permission','question','goal_done'].every(k=>info.some(r=>r.kind===k)), at+theme+' all row kinds are covered: '+JSON.stringify(info.map(r=>r.kind)));
                for (const r of info) {
                    const label = at + theme + ' ' + r.text;
                    if (r.heading && r.icon) check(Math.abs(r.heading.y-r.icon.y)<4 && (!r.headingInk || Math.abs(r.headingInk.y-r.icon.y)<6), label+' heading is top-aligned with its icon: '+JSON.stringify(r));
                    check(r.implied.every(n=>n.right-n.x<=1.1 && n.clip==='inset(50%)'),label+' implied intros stay accessible but visually hidden');
                    if (r.kind==='question') check(r.runtimeDots.every(d=>d==='none'||d==='normal') && r.messages.length===1 && r.messageTexts.every(t=>!/^Wants to know:/.test(t)) && r.decisions.every(b=>b.y>=r.messages[0].bottom), label+' live prompt has one unprefixed box above its choices');
                    if (r.kind==='permission') check(r.common.length===1 && r.common[0].text==='Dismiss' && !r.common[0].isMore, label+' only direct Dismiss at footer right (no More/Save/Star)');
                    if (r.kind==='ask') check(r.common.length===0, label+' Dismiss is already direct, so there is no redundant one-item More');
                    if (['review','ask','goal_done'].includes(r.kind)) check(r.messages.length>0, label+' has a separate message box');
                    if (r.kind==='permission') check(r.commandHeader, label+' command metadata has its own header');
                    if (mobile) check(r.messages.every(m=>Math.abs(m.x-(r.row.x+17))<3), label+' phone message spans the card content width: '+JSON.stringify(r));
                    check(r.messages.every(m=>r.metadata.every(meta=>meta.bottom<=m.y+1)), label+' metadata stays above the message box: '+JSON.stringify(r));
                    check(r.decisions.length > 0, label + ' has decisions');
                    if (!r.decisions.length || !r.title) continue;
                    check(r.decisions.every(b => b.y >= r.title.bottom - 1), label + ' decisions under the text: ' + JSON.stringify(r));
                    check(mobile || Math.abs(r.decisions[0].x-r.title.x)<4, label + ' decisions start at the text edge: ' + JSON.stringify(r));
                    if (mobile) check([...r.decisions,...r.common].every(b=>b.right-b.x>=43.5 && b.bottom-b.y>=43.5), label+' every footer control has a 44 px target: '+JSON.stringify(r));
                    check([...r.decisions,...r.common].every(b=>b.x>=r.row.x && b.right<=r.row.right+1), label + ' controls fit inside row');
                    if (mobile && r.kind==='review' && r.common.length) check(Math.max(...r.common.map(b=>b.y))-Math.min(...r.decisions.map(b=>b.y))<4, label+' all review controls stay on the same 390 px footer line');
                    if (r.common.length) check(r.common[0].x>r.decisions[0].x && r.common.every(b=>b.y>=r.title.bottom-1), label + ' common controls at footer right: ' + JSON.stringify(r));
                }
                check(await ev(`[...document.querySelectorAll('${T} .inbox-row-more > .menu')].every(m=>m.querySelectorAll('.menu-item').length>1)`), at+theme+' More is reserved for multiple actions');
                check(await ev(`!!document.querySelector('.inbox-copy-for-agent') && !document.querySelector('.needs-more [aria-haspopup]')`),at+theme+' Copy for an agent is a plain header action');
                check(await ev(`[...document.querySelectorAll('button.goals-chip')].every(b=>!/(?:^| )0$/.test(b.textContent.trim()))`),at+theme+' zero-count kinds are hidden');
                check(await ev(`[...document.querySelectorAll('.inbox-changes')].every(b=>!b.title)`),at+theme+' Request changes has no redundant native tooltip');
                if(mobile)check(await ev(`(() => {const row=document.querySelector('${T} .inbox-goaldone-actions')?.closest('tr'),heading=row?.querySelector('.inbox-review-from');if(!heading)return false;const r=heading.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(heading);return [...range.getClientRects()].every(b=>b.left>=r.left-1&&b.right<=r.right+1);})()`),at+theme+' a missing computer chip leaves room for the whole goal-done heading');
                const previews = await ev(`(() => [...document.querySelectorAll('${T} .inbox-preview')].map(e=>{const text=e.querySelector('.inbox-preview-text'),cs=getComputedStyle(text);return {text:e.textContent.slice(0,30),cap:cs.webkitLineClamp,lines:text.clientHeight/parseFloat(cs.lineHeight)};}))()`);
                check(previews.length>0&&previews.every(p=>p.cap==='4'&&p.lines<=4.1),at+theme+' every message preview is at most four lines with native ellipsis: '+JSON.stringify(previews));
                const neutral = await ev(`(() => {const e=document.querySelector('${T} .inbox-blocks-closes');if(!e)return null;const probe=document.createElement('span');probe.style.cssText='color:var(--text-secondary);border:1px solid var(--border)';e.after(probe);const a=getComputedStyle(e),b=getComputedStyle(probe),result={color:a.color,expected:b.color,border:a.borderTopColor,expectedBorder:b.borderTopColor,background:a.backgroundColor,icon:getComputedStyle(e,'::before').color};probe.remove();return result;})()`);
                check(neutral&&neutral.color===neutral.expected&&neutral.icon===neutral.color&&neutral.border===neutral.expectedBorder&&neutral.background==='rgba(0, 0, 0, 0)',at+theme+' Closes goal uses neutral text/border and no green fill: '+JSON.stringify(neutral));
                const full = await ev(`(() => {const m=[...document.querySelectorAll('${T} .inbox-message')].find(e=>e.textContent.includes('LAST-LINE'));if(!m)return null;const b=m.nextElementSibling;return {present:!!b?.matches('.inbox-preview-toggle'),visible:!!b?.getClientRects().length,text:m.textContent};})()`);
                check(full&&full.present&&full.visible,at+theme+' long numbered question has one-click Show all');
                if(full?.visible){ await ev(`(() => {const m=[...document.querySelectorAll('${T} .inbox-message')].find(e=>e.textContent.includes('LAST-LINE'));m.nextElementSibling.click();return true;})()`); await ev(framesJs(2)); const expanded=await ev(`(() => {const m=[...document.querySelectorAll('${T} .inbox-message')].find(e=>e.textContent.includes('LAST-LINE'));return m.classList.contains('inbox-preview-expanded')&&m.querySelector('.inbox-preview-text').scrollHeight<=m.querySelector('.inbox-preview-text').clientHeight+1&&m.textContent.includes('LAST-LINE');})()`);check(expanded,at+theme+' one click exposes the whole numbered question');await shot(`footer-v4-expanded-question-${w}-${theme}`);await ev(`document.querySelector('${T} .inbox-preview-expanded').nextElementSibling.click();true`);await ev(framesJs(2)); }

                const ask = info.find(r=>r.text.includes('Which release day?'));
                check(ask && ['Monday','Friday','Custom answer','Dismiss'].every(t=>ask.decisions.some(b=>b.text===t)), at+theme+' question choices, Custom answer and Dismiss: '+JSON.stringify(ask));
                if (mobile && ask) { const dismiss = ask.decisions.find(b=>b.text==='Dismiss'); check(dismiss && dismiss.right-dismiss.x > ask.row.right-ask.row.x-40, at+theme+' Dismiss has the full phone card width'); }
                await checkFooterOrder(at+theme+' waiting on you');
                await shot(`footer-v4-${w}-${theme}`);
                await ev(`document.querySelector('${T} .inbox-kind-icon[data-kind=permission]')?.closest('tr').scrollIntoView({block:'center'});true`); await ev(framesJs(2));
                await shot(`footer-v4-lower-${w}-${theme}`);
                await ev(`document.querySelector('${T} .inbox-kind-icon[data-kind=question]')?.closest('tr').scrollIntoView({block:'center'});true`); await ev(framesJs(2)); await shot(`footer-v4-live-question-${w}-${theme}`);
                await ev(`document.querySelector('${T} tbody tr')?.scrollIntoView({block:'start'});true`);
                await ev(`document.querySelector('[data-needs-tab="agent"]').click();true`);
                await waitFor(`[...document.querySelectorAll('${T} tbody tr')].some(r=>r.textContent.includes('report.md'))`, 'sent-back footer', 10000);
                await waitFor(`!!document.querySelector('${T} .inbox-sent-back-ask:not([hidden])') && !!document.querySelector('${T} .inbox-wait-line')`, 'sent-back quote and asleep notice', 10000);
                const sent = await ev(`(() => { const r=[...document.querySelectorAll('${T} tbody tr')].find(r=>r.textContent.includes('report.md')), f=r.querySelector('.inbox-v4-footer'), quote=r.querySelector('.inbox-sent-back-ask');const rr=r.getBoundingClientRect(), spans=[...r.querySelectorAll('.inbox-sent-back-ask:not([hidden]), .inbox-wait-line')].map(n=>n.getBoundingClientRect().width);return {fullWidth:spans.length>=2 && spans.every(w=>w>rr.width*.7),footer:!!f,below:!!f && (!quote || f.getBoundingClientRect().top>=quote.getBoundingClientRect().bottom-1)};})()`);
                check(sent.footer && sent.below && sent.fullWidth, at+theme+' sent-back actions are below the quote: '+JSON.stringify(sent));
                await checkFooterOrder(at+theme+' waiting on an agent');
                await shot(`footer-v4-agent-${w}-${theme}`);
                await ev(`document.querySelector('[data-needs-tab="you"]').click();true`);
                await waitFor(`[...document.querySelectorAll('${T} tbody tr')].some(r=>r.textContent.includes('plan-1.md'))`, 'return to Waiting on you', 10000);

            }
        }
        // With no files or board asks, phones use the shared mail renderer. It keeps the same footer.
        await Emulation.setDeviceMetricsOverride({width:390,height:1000,deviceScaleFactor:1,mobile:true});
        await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const real=window.fetch; window.fetch=(u,o)=>new URL(String(u),location.origin).pathname==='/api/sessions/live/be/chat' ? Promise.resolve(new Response(JSON.stringify({messages:[],total:0,prompt_options:{question:'Proceed?',ask_id:'mail-footer',target:'git status --short',options:[{n:1,label:'Yes',action:'select'},{n:2,label:'No',action:'select'}]}}),{headers:{'Content-Type':'application/json'}})) : new URL(String(u),location.origin).pathname==='/api/sessions/live/qa/chat' ? Promise.resolve(new Response(JSON.stringify({messages:[],total:0,prompt_options:{question:'Pick a color',ask_id:'mail-question',options:[{n:1,label:'Red',action:'select'},{n:2,label:'Blue',action:'select'}]}}),{headers:{'Content-Type':'application/json'}})) : real(u,o);return true;})()`);
        await ev(`(async()=>{const {state}=await import(${S}+'state.js');state.liveSessions=[{name:'be',session_id:'footer-only-agent',display_name:'Backend Dev',agent_type:'claude',server:'local',status:'idle',board_project:'${team}',waiting_for_input:true,waiting_kind:'permission',waiting_summary:'Claude needs your permission',waiting_since:new Date(Date.now()-240000).toISOString()},{name:'qa',session_id:'footer-question-agent',display_name:'Question Agent',agent_type:'claude',server:'local',status:'idle',board_project:'${team}',waiting_for_input:true,waiting_kind:'question',waiting_summary:'Pick a color. '+ 'Consider the contrast against every background and state before choosing. '.repeat(6)+'MAIL-LAST: Keep all these details available.',waiting_since:new Date(Date.now()-180000).toISOString()}];const m=await import(${S}+'inbox_tab.js');m.updateInboxTab();window.switchNavTab('hub-inbox');await m.selectInboxTab('needs');return true;})()`);
        await waitFor(`!!document.querySelector('${T} .inbox-answer')`, 'agent-only choices', 10000);
        const solo=await ev(`(() => {const row=document.querySelector('${T} tr.dt-mailed'),footer=row?.querySelector('.inbox-mail-footer');return {mail:!!row,footer:!!footer,dismiss:!!footer?.querySelector('.inbox-single-action .inbox-dismiss'),more:!!footer?.querySelector('.inbox-row-more-toggle'),topMore:!!row?.querySelector(':scope > td > .dt-row-more')};})()`);
        check(solo.mail && solo.footer && solo.dismiss && !solo.more && !solo.topMore,'agent-only phone has choices and direct Dismiss in its footer: '+JSON.stringify(solo));
        await waitFor(`(document.querySelector('${T} .inbox-mail-footer .inbox-dismiss')?.getBoundingClientRect().width || 0) >= 44`, 'agent question has direct Dismiss', 10000);
        await ev(framesJs(4));
        const mailPreview=await ev(`(() => {const r=[...document.querySelectorAll('${T} tr.dt-mailed')].find(n=>n.textContent.includes('MAIL-LAST')),m=r?.querySelector('.inbox-preview'),b=r?.querySelector('.inbox-preview-toggle');return {nested:!!r?.querySelector('button button'),button:!!b&&!!b.getClientRects().length,outside:!!b&&!b.parentElement.closest('button'),below:!!b&&b.getBoundingClientRect().top>=m.getBoundingClientRect().bottom-1};})()`);
        check(mailPreview&&!mailPreview.nested&&mailPreview.button&&mailPreview.outside&&mailPreview.below,'mail-row expansion is visible below the four-line preview, outside the navigation button: '+JSON.stringify(mailPreview));
        await shot('footer-v4-agent-only-phone');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Inbox v4 footer: decisions left and below, common controls right, choice questions at both widths/themes');
})().catch(e => { console.error(e); process.exit(1); });
