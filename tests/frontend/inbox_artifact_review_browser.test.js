// #8628: for-review artifacts join Needs you; ten per producer, overflow disclosed,
// preview stays in Inbox, and Mark reviewed preserves the artifact's other tags.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'review-inbox-' + Date.now().toString(36), failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    const rows = `document.querySelectorAll('#group-table-view [data-review-artifact]')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const width of [1280,390]) {
            try {
                await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
                await Emulation.setTouchEmulationEnabled({enabled:width===390});
                await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install();
                await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`),200);
                // Mock only artifact storage; the team exists through the real board API.
                await ev(`(() => {
                    localStorage.removeItem('coral-inbox-needs-filters');
                    const style=document.createElement('style'); style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style);
                    window.__reviewWrites=[];window.__reviewFail=false;
                    window.__reviewItems=Array.from({length:13},(_,i)=>({id:(i+1).toString(16).padStart(64,'0'),name:'Review file '+String(i+1).padStart(2,'0')+'.txt',media_type:'text/plain',size:30,created_at:new Date(Date.now()-(20-i)*60000).toISOString(),task_id:0,source:'upload',available:true,session_id:i<11?'writer-a':'writer-b',produced_by:i<11?'Writer A':'Writer B',tags:['for review','internal'],uri:'coral://artifacts/'+(i+1).toString(16).padStart(64,'0')}));
                    const original=window.fetch, json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
                    window.fetch=(url,opts={})=>{
                        const u=new URL(String(url),location.origin);
                        if(u.pathname==='/api/board/${team}/artifacts'){
                            const items=window.__reviewItems.filter(a=>!u.searchParams.has('tag')||a.tags.includes(u.searchParams.get('tag'))),offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||100);
                            return json({project:'${team}',artifacts:items.slice(offset,offset+limit),has_more:offset+limit<items.length});
                        }
                        if(u.pathname.startsWith('/api/board/${team}/artifacts/')&&u.pathname.endsWith('/tags')){
                            if(window.__reviewFail)return json({error:'Review save failed'},500);
                            const id=u.pathname.split('/').at(-2),body=JSON.parse(opts.body);window.__reviewWrites.push(body);
                            window.__reviewItems.find(a=>a.id===id).tags=body.tags;return json({tags:body.tags});
                        }
                        if(u.pathname.startsWith('/api/artifacts/')&&/^[0-9a-f]{64}$/.test(u.pathname.split('/')[3])&&(u.pathname.split('/').length===4||u.pathname.split('/')[4]==='content'))return Promise.resolve(new Response('Review preview text',{headers:{'Content-Type':'text/plain'}}));
                        return original(url,opts);
                    };return true;
                })()`);
                await ev(`window.switchNavTab('hub-inbox');true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${row('Review file 01.txt')})`,'for-review artifact in Needs you',15000);
                assert.equal(await ev(`${rows}.length`),12,'ten from Writer A and two from Writer B');
                assert.match(await ev(`document.getElementById('group-table-view').textContent`),/1 more/,'overflow remains discoverable');
                assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`),'13','all pending artifacts count');
                assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow');
                assert.equal(await ev(`document.querySelector('#group-table-view .inbox-folder-head .session-group-count').textContent`),'12 of 13','heading explains the cap');
                const names = await ev(`(() => {const r=${row('Review file 01.txt')},name=r.querySelector('.inbox-review-name');return {title:name.title,text:name.textContent,open:r.querySelector('.inbox-review-actions button:not(.dt-star)').getAttribute('aria-label')};})()`);
                assert.equal(names.title,'Review file 01.txt','ellipsis keeps the full filename in its tooltip');
                assert.equal(names.text,names.title,'assistive text keeps the same full filename');
                assert.equal(names.open,'Open '+names.title,'Open action retains the full filename');
                { const st = await ev(`(() => { const r = ${row('Review file 01.txt')}, b = r.querySelector('.inbox-review-actions .dt-star'); return b ? { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), op: getComputedStyle(b).opacity, shown: getComputedStyle(b).display !== 'none' } : null; })()`);
                  assert.ok(st && st.label === 'Star Review file 01.txt' && st.pressed === 'false', `${width}: a review row has the star, named for the file: ` + JSON.stringify(st)); // Needs you's artifact rows take the star too (#9834): a button at a hover, nothing on touch
                  if (width === 1280) assert.equal(st.op, '0', '1280: it is hidden at rest and shows on a hover'); else assert.equal(st.shown, false, '390: no star control on touch'); }
                const layout = await ev(`(() => {const r=${row('Review file 01.txt')}, buttons=[...r.querySelectorAll('.inbox-review-actions button:not(.dt-star)')], rects=buttons.map(b=>b.getBoundingClientRect());const team=r.querySelector('.inbox-review-team');return {actionsBesideName:rects[0].left>r.querySelector('.inbox-review-name').getBoundingClientRect().right-1&&Math.abs(rects[0].top+rects[0].height/2-(r.querySelector('.inbox-review-name').getBoundingClientRect().top+r.querySelector('.inbox-review-name').getBoundingClientRect().height/2))<2,team:team.textContent,teamHeight:team.getBoundingClientRect().height,teamFits:team.scrollWidth<=team.clientWidth+1,height:r.getBoundingClientRect().height,sameLine:Math.abs(rects[0].top-rects[1].top)<2,standard:buttons.every(b=>!b.classList.contains('dt-quiet')&&!b.disabled)};})()`);
                assert.ok(layout.sameLine,'both actions stay on one line');
                if(width===390){assert.equal(layout.team,team,'phone keeps the full team name');assert.ok(layout.teamHeight>0&&layout.teamFits,'team metadata is visible and wraps within the row');}
                if(width===390)assert.ok(layout.actionsBesideName,'actions sit to the right of the filename on the same line');
                assert.ok(layout.height<(width===390?96:41),'compact review row (a phone row has the goal on its second line, #8917, so its waiting time may be a third): '+JSON.stringify(layout));
                assert.ok(layout.standard,'standard enabled button treatment');
                if(width===390)assert.ok(await ev(`[...(${row('Review file 01.txt')}).querySelectorAll('.inbox-review-actions button:not(.dt-star)')].every(b=>b.getBoundingClientRect().height>=44)`),'review actions keep 44px touch targets');

                const dir=process.env.CORAL_SCREENSHOT_DIR||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'out'));
                if(dir){fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`);fs.writeFileSync(path.join(dir,`inbox-review-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
                await ev(`[...(${row('Review file 01.txt')}).querySelectorAll('button')].find(b=>b.textContent.trim()==='Open').click();true`);
                await waitFor(`document.body.textContent.includes('Review preview text')`,'artifact preview');
                assert.equal(await ev(`document.body.dataset.navTab`),'hub-inbox','preview keeps Inbox');
                // Close the shared viewer using its visible control, retaining the list.
                await ev(`document.querySelector('.artifact-viewer-close').click();true`);
                await ev(`window.__reviewFail=true;[...(${row('Review file 01.txt')}).querySelectorAll('button')].find(b=>b.textContent.trim()==='Mark reviewed'||(b.getAttribute('aria-label')||'').startsWith('Mark reviewed')).click();true`);
                await waitFor(`document.body.textContent.includes('Review save failed')`,'failed save is visible');
                assert.ok(await ev(`!!(${row('Review file 01.txt')})`),'failed save keeps row');
                await ev(`window.__reviewFail=false;[...(${row('Review file 01.txt')}).querySelectorAll('button')].find(b=>b.textContent.trim()==='Mark reviewed'||(b.getAttribute('aria-label')||'').startsWith('Mark reviewed')).click();true`);
                await waitFor(`!(${row('Review file 01.txt')})`,'reviewed row removed');
                assert.deepEqual((await ev(`window.__reviewWrites.at(-1).tags`)).sort(),['internal','reviewed']);
                assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`),'12');
                assert.ok(await ev(`!!(${row('Review file 11.txt')})`),'overflow promotes next artifact');
                assert.equal(await ev(`document.querySelector('#group-table-view .inbox-folder-head .session-group-count').textContent`),'12','heading and badge agree after review');
                if(dir){for(const theme of ['light','dark']){await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`);fs.writeFileSync(path.join(dir,`inbox-reviewed-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
                console.log('PASS review artifacts '+width);
            } catch(error){failures.push(width+': '+error.message);console.error(failures.at(-1));}
        }
        assert.equal(failures.length,0,failures.join('\n'));
    } finally {await removeBoards(ev,[team]).catch(()=>{});await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
