// #16373: Send and Enter with blank text show a quiet inline hint, cleared on typing; never POST a blank message.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const BOARD = 'qa-empty-board-message';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source: PRELOAD});
        await Page.addScriptToEvaluateOnNewDocument({source: `(() => { const inner = window.fetch; window.__messagePosts = [];
            window.fetch = (u,o = {}) => { const p = new URL(String(u && u.url || u), location.href).pathname;
                if (p === '/api/board/${BOARD}/messages' && o.method === 'POST') window.__messagePosts.push(JSON.parse(o.body));
                return inner(u,o); }; })();`});
        for (const width of [1440,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width === 390});
            await Page.navigate({url:BASE + '/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${BOARD}/subscribe', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Lead',job_title:'Orchestrator'})}).then(r=>{if(!r.ok)throw new Error('subscribe '+r.status);});`);
            await ev(`window.selectBoardProject('${BOARD}'); true`);
            await waitFor(`!!document.querySelector('#team-page-view #mb-post-input')?.getClientRects().length`, 'board composer', 8000);
            for (const value of ['', '   \n  ']) for (const method of ['Send','Enter']) {
                await ev(`(() => { const t=document.querySelector('#mb-post-input'); t.value=${JSON.stringify(value)}; t.dispatchEvent(new Event('input',{bubbles:true})); t.focus(); })()`);
                if (method === 'Send') await ev(`document.querySelector('#team-page-view [data-on-click="mb-post"]').click(); true`);
                else { await Input.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); }
                await waitFor(`document.querySelector('#mb-post-hint')?.textContent === 'Write a message first.'`, width + ' ' + method + ' blank hint', 3000);
                assert.equal(await ev('window.__messagePosts.length'),0,'blank submit sends no request');
                assert.equal(await ev(`document.activeElement.id`),'mb-post-input','focus returns to composing');
                assert.equal(await ev(`document.querySelector('#mb-post-hint').getAttribute('role')`),'status','quiet polite status');
                assert.ok(await ev(`document.querySelector('#mb-post-input').getAttribute('aria-describedby').split(/\\s+/).includes('mb-post-hint')`),'hint describes the box');
                await Input.insertText({text:'A real message'});
                await waitFor(`document.querySelector('#mb-post-hint').textContent === ''`, 'typing clears the hint', 3000);
            }
            await ev(`document.querySelector('#team-page-view [data-on-click="mb-post"]').click(); true`);
            await waitFor('window.__messagePosts.length === 1','valid message posts once',5000);
            assert.equal(await ev('window.__messagePosts[0].content'),'A real message');
            await waitFor(`document.querySelector('#mb-post-input').value === ''`,'sent draft clears',5000);
        }
        console.log('PASS blank Board sends give a hint and no POST; typing clears it and a real message still sends');
    } finally { await removeBoards(ev,[BOARD]).catch(()=>{}); await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
