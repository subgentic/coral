// A board message's actions sheet on a phone (#10730, Mobile pass 38): the sheet was titled "Message from Operator, 2" and the person asked what the 2 is. It was the message's time, "2:57 PM", cut at its colon (the title is the
// More button's name with the snippet after the first ":" taken off). The title is now the sender and the whole time: "Message from operator, 2:57 PM". At 390 px; a real board over the API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'identity-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 764, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-s' }), 200);
        assert.equal(await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'operator', content: 'Hello: a message with a colon in it' }), 200);
        assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id:'access',job_title:'Accessibility Checker',session_name:'access-s'}),200);
        assert.equal(await api('POST', `/api/board/${B}/messages`, {subscriber_id:'access',content:'Second-specific accessibility message'}),200);
        await Page.navigate({ url: `${BASE}/team/${B}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`[...document.querySelectorAll('#mb-messages .mb-msg-more')].some(b=>b.closest('.mb-message').textContent.includes('Second-specific'))`, 'the second message and its More button', 15000);
        await ev(`window.__boardOpener=[...document.querySelectorAll('#mb-messages .mb-msg-more')].find(b=>b.closest('.mb-message').textContent.includes('Second-specific'));true`);
        const label = await ev(`window.__boardOpener.getAttribute('aria-label')`);
        await ev(`window.__boardOpener.setAttribute('aria-label','Actions for the message from Coral, 11:28 PM: stale label');true`);
        await ev(`window.__boardOpener.click(); true`);
        await waitFor(`!!document.getElementById('mb-actions-title') && document.getElementById('mb-actions-title').getClientRects().length > 0`, 'the actions sheet', 5000);
        const identity = await ev(`(()=>{const row=window.__boardOpener.closest('.mb-message');const save=row.querySelector('.mb-save-btn'),del=row.querySelector('.mb-delete-msg-btn');window.__target=null;for(const b of [save,del])if(b)b.addEventListener('click',e=>{window.__target={id:row.dataset.messageId,kind:b===del?'delete':'save'};e.preventDefault();e.stopImmediatePropagation()},true);return{id:row.dataset.messageId,saveVisible:!!save&&save.getClientRects().length>0}})()`);
        await ev(`(()=>{const b=[...document.querySelectorAll('.mb-actions-sheet button')].find(b=>b.textContent==='Delete message');b.click();return true})()`);
        assert.deepEqual(await ev('window.__target'),{id:identity.id,kind:'delete'},'Delete acts on the opened row');
        await waitFor(`!document.querySelector('dialog.mb-actions-sheet')`, 'Delete sheet removed before reopening', 5000);
        await ev(`window.__boardOpener.click();true`);
        await waitFor(`!!document.querySelector('dialog.mb-actions-sheet[open]') && document.querySelector('dialog.mb-actions-sheet[open] .mb-actions-item')?.textContent === 'Save for later'`, 'the reopened sheet and its Save action', 5000);
        const title = await ev(`document.getElementById('mb-actions-title').textContent`);
        const m = /^Actions for the (message from .+?, \d{1,2}:\d{2}(?:\s?[AP]M)?)(?::|$)/.exec(label);
        if (!m) problems.push(`the More button's name is "Actions for the message from <sender>, <time>: <words>" (it is "${label}")`);
        else if (title !== 'M' + m.slice(1)[0].slice(1)) problems.push(`the sheet is titled with the sender and the whole time "M${m[1].slice(1)}" (it is "${title}")`);
        if(process.env.CORAL_BOARD_SHOTS){const fs=require('node:fs');fs.mkdirSync(process.env.CORAL_BOARD_SHOTS,{recursive:true});fs.writeFileSync(process.env.CORAL_BOARD_SHOTS+'/actions.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
        await ev(`(()=>{[...document.querySelectorAll('.mb-actions-sheet button')].find(b=>b.textContent==='Save for later').click();return true})()`);
        assert.deepEqual(await ev('window.__target'),{id:identity.id,kind:'save'},'Save acts on the opened second message');
        await waitFor(`!document.querySelector('dialog.mb-actions-sheet')`,'actions sheet closes');
        await nextFrame(ev);
        for(const width of [390,1280]){
            await Emulation.setDeviceMetricsOverride({width,height:764,deviceScaleFactor:1,mobile:width===390});
            await ev(`window.__boardOpener.closest('.mb-message').scrollIntoView({block:'end'});true`);
            const clear=await ev(`(()=>{const r=window.__boardOpener.closest('.mb-message'),b=r.querySelector('.mb-save-btn').getBoundingClientRect(),f=document.querySelector('.mb-post-form').getBoundingClientRect();return b.bottom<=f.top+1})()`);
            if(!clear)problems.push(width+': bookmark is clipped under composer');
            if(process.env.CORAL_BOARD_SHOTS){const fs=require('node:fs');fs.mkdirSync(process.env.CORAL_BOARD_SHOTS,{recursive:true});fs.writeFileSync(process.env.CORAL_BOARD_SHOTS+'/board-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
        }
        if(!identity.saveVisible)problems.push('Save bookmark is visible without More');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the actions sheet title:\n  ' + problems.join('\n  '));
    console.log('PASS the actions sheet is titled with the sender and the whole time');
})().catch(e => { console.error(e); process.exit(1); });
