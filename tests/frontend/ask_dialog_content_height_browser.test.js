// #20383: a short reply sheet fits its content; a long one stops at the viewport
// cap and scrolls its reader. Same question/reply layout for board/agent questions
// and choices. File viewer excluded by Orchestrator's scope amendment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { BASE } = require('./test_base');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const errors = [];
    const check = (yes, name, data) => { console.log(`${yes ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(data)}`); if (!yes) errors.push(name + ': ' + JSON.stringify(data)); };
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const close = () => ev(`(() => { const d=document.querySelector('dialog.inbox-ask-dialog[open]'); d?.querySelector('.inbox-ask-buttons .btn:last-child')?.click(); return true; })()`);
    const open = async (kind, text, buttons = []) => {
        await ev(`import((window.__coralStatic || '/static/')+'operator_asks.js').then(m => m.openAskDialog({server:'local',board:'release',board_label:'Release team',kind:${JSON.stringify(kind)},id:41,asker:'Orchestrator',text:${JSON.stringify(text)},at:'2026-11-21T10:00:00Z',buttons:${JSON.stringify(buttons)}}, () => {})).then(() => true)`);
        await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .ac-add-image')`, 'reply sheet and image picker');
        await ev(framesJs(3));
    };
    const measure = () => ev(`(() => {
        const d=document.querySelector('dialog.inbox-ask-dialog[open]'), r=d.getBoundingClientRect(), f=d.querySelector('.inbox-ask-foot').getBoundingClientRect();
        const visible=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
        const ends=[...d.querySelectorAll('.inbox-ask-reading > *, .inbox-ask-compose > *')].filter(visible).map(e=>e.getBoundingClientRect().bottom);
        const reader=d.querySelector('.inbox-ask-reading'), narrow=getComputedStyle(reader).display==='contents', scroll=narrow?d:reader;
        const s=d.querySelector('.inbox-ask-send'), b=s.getBoundingClientRect(), top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
        return {height:r.height, cap:innerHeight*.9, gap:f.top-Math.max(...ends), footerInside:f.bottom<=r.bottom+1, overflow:d.scrollWidth>d.clientWidth+1, bodyScroll:scroll.scrollHeight>scroll.clientHeight+1, sendHit:top===s || s.contains(top), sendInside:b.top>=0 && b.bottom<=innerHeight};
    })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, theme, doubled] of [[1280,'dark',false],[1280,'light',false],[390,'dark',false],[390,'light',false],[1280,'dark',true],[390,'dark',true]]) {
            const tag=`${width}-${theme}-${doubled?'200':'100'}`;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width===390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width===390 });
            await Page.navigate({ url: BASE+'/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)}); document.documentElement.style.fontSize=${JSON.stringify(doubled?'32px':'')}; window.switchNavTab('hub-inbox'); true`);
            await open('ask', 'The release is ready. May the team go ahead?\nPlease choose when you have checked the report.');
            const m=await measure(); await shot('ask-short-'+tag);
            check(m.height<=m.cap+2 && !m.overflow && (m.footerInside || (width===390 && m.bodyScroll)), tag+' short sheet fits viewport', m);
            // At 200% on a phone the short text may fill the cap: the sticky send
            // row can overlap the scrolling text, but content remains reachable.
            check((width===390 && doubled) || (m.gap>=-2 && m.gap<=32), tag+' footer follows last content within 32px', m);
            check(m.sendInside && m.sendHit, tag+' Send reply reachable', m);
            if (width===390 && m.bodyScroll) {
                await ev(`document.querySelector('dialog.inbox-ask-dialog[open]').scrollTop=100000; true`);
                const end=await measure(); check(end.footerInside && end.sendInside && end.sendHit, tag+' footer reachable by scrolling', end);
            }
            await close();
            if (!doubled && theme==='dark') {
                for (const [kind, buttons] of [['ask',[{id:1,label:'Yes',action:'reply',state:'pending'},{id:2,label:'No',action:'reply',state:'pending'}]],['agent',[{id:1,label:'Red',action:'reply',state:'pending'},{id:2,label:'Blue',action:'reply',state:'pending'},{id:3,label:'Green',action:'reply',state:'pending'}]],['wait',[]]]) {
                    await open(kind, 'Which plan should the team use?', buttons);
                    const choices=await measure();
                    check(choices.height<=choices.cap+2 && !choices.overflow && choices.footerInside && choices.gap<=32, `${width} ${kind} choices compact`, choices);
                    await close();
                }
                await open('ask', Array.from({length:50},(_,i)=>`Detail ${i+1}: Read this part of the release plan before answering the question.`).join('\n\n'));
                const long=await measure(); await shot('ask-long-'+tag);
                check(long.height<=long.cap+2 && long.bodyScroll && !long.overflow, width+' long sheet capped and reader scrolls', long);
                check(long.sendInside && long.sendHit, width+' long sheet Send reply reachable', long);
                await close();
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(errors, [], 'content height regression');
})().catch(e => { console.error(e); process.exit(1); });
