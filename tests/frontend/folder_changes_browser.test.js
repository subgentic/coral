// A folder row in the Agents list shows what its agents have changed (#10386, Beta #10383: "blog: 2 files changed"), from the changed_file_count the feed already carries: the number beside the count, the whole
// sentence as its tooltip; no number while nothing is changed. Isolated dev server, 1280 px, stubbed agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        const show = changes => ev(`(() => { localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.agents = {}; ${changes.map((n, i) => `window.__m.add('blog', 'A${i}', 3, { sleeping: false, session_id: 'b${i}' });`).join(' ')} const counts = ${JSON.stringify(changes)}; window._coralSetLiveSessions(Object.values(window.__m.agents).map((a, i) => ({ ...window.__m.entry(a), changed_file_count: counts[i] }))); return true; })()`);
        await show([1, 1]);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-header')`, 'the folder row', 10000);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the list draws in a frame
        const row = await ev(`(() => { const h = document.querySelector('#live-sessions-list .session-group-header .group-changes'); return h ? { text: h.textContent.trim(), title: h.title } : null; })()`);
        assert.ok(row, 'the folder row has a changes line');
        assert.equal(row.text, '2 changed', 'the folder row says how many files its agents changed');
        assert.match(row.title, /2 files changed$/, 'the tooltip says it in a sentence: ' + row.title);
        await show([0, 0]); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the list redraws
        assert.equal(await ev(`!!document.querySelector('#live-sessions-list .session-group-header .group-changes')`), false, 'nothing changed, nothing said');
        // a folder row keeps its place when an agent in it starts: the new session comes first in the feed, and the folder of the newest session used to jump to the top, from under the pointer
        await ev(`(() => { window.__m.agents = {}; window.__m.add('alpha', 'A', 3, { sleeping: false, session_id: 'a1' }); window.__m.add('beta', 'B', 3, { sleeping: false, session_id: 'b1' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); return true; })()`);
        const order = () => ev(`[...document.querySelectorAll('#live-sessions-list .session-group-header')].map(h => h.dataset.groupName)`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-header').length === 2`, 'two folder rows', 10000);
        const before = await order();
        await ev(`(() => { window.__m.add('beta', 'B2', 3, { sleeping: false, session_id: 'b2' }); const all = Object.values(window.__m.agents).map(a => window.__m.entry(a)); const first = all.filter(e => e.session_id === 'b2'); window._coralSetLiveSessions([...first, ...all.filter(e => e.session_id !== 'b2')]); return true; })()`);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the list redraws
        assert.deepEqual(await order(), before, 'the folders keep their places when an agent in the second one starts: ' + JSON.stringify(before));
        console.log('PASS a folder row says what its agents changed, and keeps its place');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
