// The board chat loads when an agent on a board is first shown (#10351); choosing a board agent and then a non-board agent before board_chat.js has loaded (sessions.js shows, then hides) leaves no
// chat on screen and no polling for the wrong agent: the later hide wins over the earlier show. A fresh page, the show and the hide in one tick. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const loaded = await ev(`import(${S} + 'import_once.js').then(m => !!m.loadedModule('./board_chat.js'))`);
        assert.equal(loaded, false, 'board_chat.js has not loaded yet on a fresh page');
        await ev(`window.__boardReqs = []; const f = window.fetch; window.fetch = (u, o) => { if (/\\/api\\/board\\/race-team\\//.test(String(u && u.url || u))) window.__boardReqs.push(String(u)); return f(u, o); }; true`);
        await ev(`import(${S} + 'render.js').then(m => { m.showBoardChatTab('race-team'); m.hideBoardChatTab(); return true; })`);
        await sleep(2500); // sleep-ok: the module loads and answers after the click; what is on screen then is what is asserted
        const panel = await ev(`(() => { const p = document.getElementById('agentic-panel-board'); return { chars: p ? p.textContent.trim().length : 0, msgs: !!document.getElementById('board-panel-msgs') }; })()`);
        assert.deepEqual(panel, { chars: 0, msgs: false }, 'the panel is empty: ' + JSON.stringify(panel));
        const reqs = await ev(`window.__boardReqs.length`);
        await sleep(1500); // sleep-ok: a poll would show as requests after this
        assert.equal(await ev(`window.__boardReqs.length`), reqs, 'no polling of the board that was hidden');
        console.log('PASS Board chat: a show then a hide before the module loads leaves nothing on screen');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
