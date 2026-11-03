// #12637: native Hub Inbox preserves Archived on desktop, touch phone, and reload.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width:1280, height:844, mobile:false, inbox:'native', hubPages:true });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const original = window.fetch;
            window.fetch = (u,o) => {
                const p = new URL(String(u), location.href).pathname;
                if (/^\\/api\\/remote\\/m[12]\\/api\\/sessions\\/history\\/chat-2$/.test(p)) {
                    window.__chatReads = (window.__chatReads || 0) + 1;
                    if (window.__chatFailure === 'network') return Promise.reject(new TypeError('offline'));
                    if (window.__chatFailure === 'json') return Promise.resolve(new Response('broken json'));
                    if (window.__chatFailure) return Promise.resolve(new Response('{}', { status:503 }));
                    return Promise.resolve(new Response(JSON.stringify({ agent_type:'claude', messages:[{type:'user', content:'Recovered transcript'}], start:0,total:1 })));
                }
                return original(u,o);
            };
        })();` });
        const open = async path => {
            await Page.navigate({ url: BASE + path }); await Page.loadEventFired();
            await waitFor(`!!window.__coralReady && typeof window.selectHistorySession === 'function'`, 'dashboard');
            await coralReady(ev, 'startup', 'liveList', 'settings');
        };
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({ width, height:844, deviceScaleFactor:1, mobile:width===390 });
            await Emulation.setTouchEmulationEnabled({ enabled:width===390 });
            await open('/inbox/chats/archived');
            await waitFor(`!!document.querySelector('#group-table-view .dt-primary')`, 'archived chat row');
            await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
            await waitFor(`document.getElementById('history-messages').textContent.includes('needle')`, 'remote transcript');
            assert.match(await ev(`location.pathname`), /^\/inbox\/chats\/archived\/@m[12]\/same-chat$/, 'folder stays in chat URL');
            const path = await ev('location.pathname');
            for (const reload of [false,true]) {
                if (reload) { await open(path); await waitFor(`document.getElementById('history-messages').textContent.includes('needle')`, 'reloaded transcript'); }
                const selector=width===390?'.mobile-history-back':'#history-back';
                assert.equal(await ev(`document.querySelector('${selector}').textContent.trim()`), '← Archived', 'back names Archived');
                await ev(`document.querySelector('${selector}').click();true`);
                await waitFor(`location.pathname === '/inbox/chats/archived' && document.getElementById('group-table-view').checkVisibility()`, 'back to Archived');
                if (!reload) { await open(path); await waitFor(`document.getElementById('history-messages').textContent.includes('needle')`, 'chat again'); }
            }
        }
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({ width, height:844, deviceScaleFactor:1, mobile:width===390 });
            await Emulation.setTouchEmulationEnabled({ enabled:width===390 });
            for (const failure of ['http','network','json']) {
                await open('/inbox/chats/archived/@m1/same-chat');
                await waitFor(`document.getElementById('history-messages').textContent.includes('needle')`, 'first chat');
                await ev(`window.__chatFailure=${JSON.stringify(failure)}; window.selectHistorySession('chat-2'); true`);
                await waitFor(`document.getElementById('history-messages').textContent.includes('Could not load this chat') && !!document.querySelector('#history-messages button')`, 'transcript error and retry');
                assert.ok(await ev(`document.getElementById('history-messages').textContent.includes('Could not load this chat')`), 'failure has a plain explanation');
                assert.ok(await ev(`!document.getElementById('history-messages').textContent.includes('needle')`), 'previous transcript cleared');
                assert.equal(await ev(`document.querySelector('#history-messages button').textContent`), 'Retry');
                await ev(`window.__chatFailure=''; document.querySelector('#history-messages button').click(); true`);
                await waitFor(`document.getElementById('history-messages').textContent.includes('Recovered transcript')`, 'retry recovers');
                assert.equal(await ev(`document.getElementById('history-messages').textContent.includes('Could not load this chat')`), false, 'error replaced');
                assert.match(await ev(`location.pathname`), /archived\/@m1\/chat-2$/, 'retry retains folder and computer');
            }
        }
        console.log('PASS archived Hub chat back link and reload at 1280 and touch 390');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
