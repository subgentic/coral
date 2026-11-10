// #15372 (user feedback): typing a long message grew the box upward over the bottom of the output. On the team's Board the messages area shrinks as the box grows and, pinned at the bottom, stays pinned (the newest message is
// still in view after ten lines); scrolled up, typing does not move the page. 1280 and 390 px, a real board.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const frames = framesJs(3), problems = [], boards = [];
    const C = `document.querySelector('.mb-messages-scroll')`;
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r => r.status)`);
    const dist = () => ev(`Math.round(${C}.scrollHeight - ${C}.scrollTop - ${C}.clientHeight)`);
    const type = n => ev(`(async () => { const i = document.getElementById('mb-post-input'); i.focus(); i.value = ${JSON.stringify(Array.from({ length: n }, (_, k) => 'line ' + (k + 1)).join('\n'))}; i.dispatchEvent(new Event('input', { bubbles: true })); await ${frames}; return Math.round(i.offsetHeight); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `, board = `composer-keeps-${w}-` + Date.now().toString(36); boards.push(board);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal(await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Orchestrator', job_title: 'Orchestrator', session_name: board }), 200);
            for (let i = 1; i <= 40; i++) assert.equal(await api('POST', `/api/board/${board}/messages`, { subscriber_id: 'Orchestrator', content: `Message ${i}: ${'a line of status text '.repeat(4)}` }), 200);
            await Page.navigate({ url: BASE + `/team/${board}/messages` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`!!${C} && ${C}.scrollHeight > ${C}.clientHeight * 1.5 && !!document.getElementById('mb-post-input')`, at + 'the board with its messages', 15000);
            await ev(`(async () => { ${C}.scrollTop = ${C}.scrollHeight; ${C}.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 300)); return true; })()`); // sleep-ok: the scroll handlers run
            const d0 = await dist(), small = await type(1); await type(0);
            const grown = await type(10), d10 = await dist();
            if (grown <= small + 20) problems.push(`${at}the box did not grow with ten lines: ${small} to ${grown}`);
            if (d0 > 2) problems.push(`${at}not at the bottom before typing: ${d0} px`);
            if (d10 > 2) problems.push(`${at}ten lines typed: the newest message is ${d10} px under the box`);
            await type(0); const back = await dist();
            if (back > 2) problems.push(`${at}box cleared: ${back} px short of the bottom`);
            for (const away of [120, 600]) {
                await ev(`(async () => { ${C}.scrollTop = Math.max(0, ${C}.scrollHeight - ${C}.clientHeight - ${away}); ${C}.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 300)); return true; })()`); // sleep-ok: the scroll handlers run
                const up = await dist(); await type(10); const up2 = await dist();
                if (Math.abs(up2 - up) > 2) problems.push(`${at}${away} px above the bottom, ten lines typed: the text above the box moved from ${up} to ${up2} px above the bottom (the box covered the messages)`);
                await type(0);
            }
        }
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the Board keeps its newest message in view as the box grows:\n  ' + problems.join('\n  '));
    console.log('PASS the newest message stays in view above a growing Board box');
})().catch(e => { console.error(e); process.exit(1); });
