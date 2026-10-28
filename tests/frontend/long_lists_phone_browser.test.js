// Long lists on a phone (#10319, Mobile pass 23): a folder with many agents shows its first 5 and "Show 19 more" (the open agent stays in view, Show fewer folds it again); the Inbox's chat folders (All chats,
// Starred, Active now, Archived) say how many they hold like the other folders; and the opened chat's Star and Archive have room between them. 390 px, isolated dev server; the counts are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return Promise.resolve(new Response(JSON.stringify({ all: 119, group: 1, notes: 9, active: 2, starred: 4, archived: 3, by_agent_type: { claude: 90, codex: 29 }, tags: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); }; return true; })()`);
        // 24 agents in one folder
        await ev(`for (let i = 0; i < 24; i++) window.__m.add('many', 'A', 4, { sleeping: false, session_id: 'many-' + String(i).padStart(2, '0') + '-id' }); true`); await sleep(1200); // sleep-ok: the list draws over frames
        await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'render.js'), import((window.__coralStatic || '/static/') + 'state.js')]).then(([r, st]) => { r.renderLiveSessions(st.state.liveSessions); return true; })`);
        const rows = () => ev(`document.querySelectorAll('.session-group-item[data-session-id]').length`);
        const more = () => ev(`(() => { const r = document.querySelector('.folder-more-row'); return r ? r.textContent.trim() : null; })()`);
        await waitFor(`document.querySelectorAll('.session-group-item[data-session-id]').length > 0`, 'rows ' + await ev(`JSON.stringify([[...document.querySelectorAll('.session-group-header')].map(h => h.textContent.trim().slice(0, 40)), document.querySelectorAll('.session-group-item').length])`), 8000);
        assert.equal(await rows(), 5, 'a long folder shows its first 5 ' + await ev(`JSON.stringify([document.querySelectorAll('.session-group-item[data-session-id]').length, [...document.querySelectorAll('.session-group-header')].map(h => h.textContent.trim().slice(0, 30)), [...document.querySelectorAll('.session-group-item')].slice(0, 3).map(r => r.closest('ul') && r.closest('ul').id)])`));
        assert.equal(await more(), 'Show 19 more', 'and says how many more');
        await ev(`document.querySelector('.folder-more-row .row-btn').click(); true`);
        await waitFor(`document.querySelectorAll('.session-group-item[data-session-id]').length === 24`, 'all 24 after Show more', 5000);
        assert.equal(await more(), 'Show fewer', 'it can be folded again');
        await ev(`document.querySelector('.folder-more-row .row-btn').click(); true`);
        await waitFor(`document.querySelectorAll('.session-group-item[data-session-id]').length === 5`, 'folded again', 5000);
        // the open agent stays in view when the folder is folded
        await ev(`window.selectLiveSession('many', 'claude', 'many-20-id', 'local'); true`); await sleep(800); // sleep-ok: the list redraws over frames
        await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'render.js'), import((window.__coralStatic || '/static/') + 'state.js')]).then(([r, st]) => { r.renderLiveSessions(st.state.liveSessions); return true; })`);
        assert.equal(await ev(`!!document.querySelector('.session-group-item[data-session-id="many-20-id"]')`), true, 'the open agent is listed though it is the 21st');

        // the Inbox's chat folders say how many they hold
        await ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => m.loadChatCounts ? m.loadChatCounts() : null).then(() => true)`).catch(() => {});
        await ev(`window.switchNavTab('hub-inbox'); true`); await sleep(800); // sleep-ok: the folder list draws over frames
        const folders = await ev(`Object.fromEntries([...document.querySelectorAll('.view-list-item')].map(b => [b.dataset.key, ((b.querySelector('.view-list-count') || {}).textContent || '').trim()]))`);
        const want = { chats: '119', 'chats-starred': '4', 'chats-active': '2', 'chats-archived': '3' };
        for (const [k, v] of Object.entries(want)) assert.equal(folders[k], v, `${k} says how many it holds: ${JSON.stringify(folders)}`);

        // the opened chat's Star and Archive have room between them
        const gap = await ev(`parseFloat(getComputedStyle(document.getElementById('history-flags')).columnGap)`);
        assert.ok(gap >= 8, `Star and Archive are ${gap} px apart on a phone`);
        console.log('PASS Long lists on a phone: a folder folds at 5 with Show 19 more, the chat folders have counts, Star and Archive have room');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
