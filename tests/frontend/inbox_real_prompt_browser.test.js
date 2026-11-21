// #20378: real ready-mode mock, real hooks/live feed/chat/answer route, one native
// tap at 390. No agent_view_harness or response stubs: those hide launched agents.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CDP = require('chrome-remote-interface');
const { BASE } = require('./test_base');
const { readyMock } = require('./helpers/ready_mock_agent');
const { touchTap } = require('./helpers/touch_tap');
if (process.platform === 'win32') { console.log('SKIPPED: ready mock wrapper requires POSIX'); process.exit(0); }
(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, {method:${JSON.stringify(method)}, headers:{'Content-Type':'application/json'}, body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,data:await r.json()}))`);
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    let mock;
    try {
        await Page.enable(); await Runtime.enable();
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'light' }] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        mock = await readyMock(api);
        for (const [kind, command] of [['permission', 'MOCK_ASK_PERMISSION'], ['question', 'MOCK_ASK_QUESTION']]) {
            const a = await mock.launch('Real ' + kind + ' mock');
            const id = JSON.stringify(a.session_id);
            const row = `(window._coralGetLiveSessions() || []).find(s => s.session_id === ${id})`;
            await waitFor(`!!(${row}) && !(${row}).starting`, kind + ': real launched agent in live feed', { timeout: 40000 });
            const route = `/api/sessions/live/${encodeURIComponent(a.session_name)}`;
            const sent = await api('POST', route + '/send', { command, agent_type: 'claude', session_id: a.session_id });
            assert.equal(sent.status, 200, JSON.stringify(sent.data));
            await waitFor(`!!(${row})?.waiting_for_input`, kind + ': hooks publish the real prompt', { timeout: 20000 });
            console.log(kind + ': real live row ' + JSON.stringify(await ev(`({waiting:(${row}).waiting_for_input,kind:(${row}).waiting_kind})`)));
            await ev(`document.getElementById('nav-select').click(); true`);
            await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, 'Inbox in the view dropdown');
            await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-answer').length >= 2`, kind + ': real prompt choices in Inbox', { timeout: 15000 });
            await waitFor(`(() => { const b=document.querySelector('#group-table-view .inbox-answer'); if(window.__lastChoice!==b){window.__lastChoice=b;window.__choiceAt=performance.now();return false;} return performance.now()-window.__choiceAt>500; })()`, kind + ': choices settled');
            const point = await ev(`(() => {const b=document.querySelector('#group-table-view .inbox-answer');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,label:b.textContent,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b};})()`);
            assert.ok(point.hit, kind + ': native touch hits the choice');
            await shot('real-' + kind + '-before-390');
            await touchTap(client, point);
            await waitFor(`!(${row})?.waiting_for_input`, kind + ': one tap clears real waiting state', { timeout: 20000 });
            assert.equal(await ev(`[...document.querySelectorAll('[role="dialog"]')].some(d => d.getClientRects().length && getComputedStyle(d).visibility !== 'hidden')`), false, kind + ': no second choice sheet');
            await shot('real-' + kind + '-answered-390');
            console.log('PASS real ' + kind + ': one native tap on ' + point.label + ', hook wait cleared');
        }
    } finally { if (mock) await mock.stop(); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
