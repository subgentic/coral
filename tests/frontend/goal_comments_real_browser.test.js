// Comments on a goal against the REAL isolated server (#11955): the goal page's Comments tab is the document comments' panel pointed at a goal. A team with an agent session and a goal are made through the board API;
// the tab opens the panel, a comment goes up on the whole goal with a picture picked through the composer's real file input (stored by the goal-images route, named by the comment), the thread shows it with its
// picture, Resolve and Reopen work, the tab's count follows, and it is all still there after a reload; a phone's width does not scroll sideways. The comment is stored under the goal's key and is not an artifact's.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gcm-' + Date.now().toString(36);
    const SID = 'b1b2c3d4-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'claude-' + SID })).status < 300);
        const made = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Ship the importer', outcome: 'Imports run nightly', done_when: 'Ten nights green' });
        assert.equal(made.status, 201, JSON.stringify(made));
        const G = made.body.id || (made.body.goal && made.body.goal.id);
        assert.ok(G, JSON.stringify(made.body));
        const KEY = `goal:${B}:${G}`;

        console.log('1. The goal page has a Comments tab; it opens the panel with the goal\'s own words');
        await load(`/team/${B}/goals/${G}`);
        await waitFor(`!!document.querySelector('#team-panel-goals #goal-tab-comments')`, 'the Comments tab', 15000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#team-panel-goals .goal-tabs .goal-tab-label')].map(n => n.textContent)`), ['Tasks', 'Artifacts', 'Comments']);
        await ev(`document.querySelector('#team-panel-goals #goal-tab-comments').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .goal-comments .ac-whole')`, 'the comment button', 15000);
        assert.match(await ev(`document.querySelector('#team-panel-goals .goal-comments .ac-whole').textContent`), /Comment on this goal/);
        assert.match(await ev(`document.querySelector('#team-panel-goals .goal-comments').textContent`), /No comments yet/);
        console.log('   ✓');

        console.log('2. A comment with a picture: the real route stores it, Send names it, the thread shows it');
        await ev(`document.querySelector('#team-panel-goals .goal-comments .ac-whole').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .ac-composer .ac-input')`, 'the composer', 8000);
        await ev(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'sketch.png', { type: 'image/png' })); const i = document.querySelector('#team-panel-goals .ac-composer .ac-picker input'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .ac-composer .ac-thumb-img').length === 1 && document.querySelectorAll('#team-panel-goals .ac-composer .ac-thumb-uploading').length === 0`, 'the stored thumbnail', 8000);
        assert.equal(await ev(`document.querySelectorAll('#team-panel-goals .ac-composer .ac-thumb-failed').length`), 0, 'the goal pictures route took it');
        await ev(`(() => { const t = document.querySelector('#team-panel-goals .ac-composer .ac-input'); t.value = 'Please also cover the retries.'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await ev(`document.querySelector('#team-panel-goals .ac-composer .ac-send').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .goal-comments .ac-card').length === 1`, 'the thread', 8000);
        assert.match(await ev(`document.querySelector('#team-panel-goals .goal-comments .ac-card').textContent`), /Please also cover the retries\./);
        assert.match(await ev(`document.querySelector('#team-panel-goals .goal-comments .ac-quote').textContent`), /This goal/);
        await waitFor(`document.querySelectorAll('#team-panel-goals .goal-comments .ac-pic-img').length === 1 && [...document.querySelectorAll('#team-panel-goals .goal-comments .ac-pic-img')].every(i => i.complete && i.naturalWidth > 0)`, 'the picture drawn', 8000);
        assert.equal((await ev(`document.querySelector('#team-panel-goals #goal-tab-comments .goal-tab-count').textContent`)).trim(), '1');
        const listed = await api('GET', `/api/artifacts/${KEY}/comments`);
        assert.equal(listed.status, 200, JSON.stringify(listed));
        assert.equal(listed.body.comments.length, 1);
        assert.equal(listed.body.comments[0].board, B, 'the goal\'s team');
        assert.equal(listed.body.comments[0].images.length, 1);
        console.log('   ✓');

        console.log('3. Resolve and Reopen, the count, and a reload');
        await ev(`document.querySelector('#team-panel-goals .goal-comments .ac-resolve').click(); true`);
        await waitFor(`(document.querySelector('#team-panel-goals #goal-tab-comments .goal-tab-count').textContent || '').trim() === '0'`, 'the count down to 0', 8000);
        await ev(`document.querySelector('#team-panel-goals .goal-comments .ac-showresolved').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .goal-comments .ac-card.ac-resolved')`, 'the resolved thread', 8000);
        await ev(`document.querySelector('#team-panel-goals .goal-comments .ac-resolve').click(); true`);
        await waitFor(`(document.querySelector('#team-panel-goals #goal-tab-comments .goal-tab-count').textContent || '').trim() === '1'`, 'reopened: the count is 1', 8000);
        await load(`/team/${B}/goals/${G}`);
        await ev(`document.querySelector('#team-panel-goals #goal-tab-comments').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .goal-comments .ac-card').length === 1`, 'the thread after a reload', 15000);
        console.log('   ✓');

        console.log('4. Not an artifact\'s comment, and nothing leaks through the artifact routes');
        const as = await api('GET', `/api/artifacts/${'a'.repeat(64)}/comments`);
        assert.notEqual(as.status, 200, 'an artifact with no file has no comments to list');
        const bad = await api('GET', `/api/artifacts/goal:${B}:999999/comments`);
        assert.equal(bad.status, 404, 'a goal that is not there');
        console.log('   ✓');

        console.log('5. A phone: the tab and the thread, nothing scrolls sideways');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await load(`/team/${B}/goals/${G}`);
        await waitFor(`!!document.querySelector('#team-panel-goals #goal-tab-comments')`, 'the tab on a phone', 15000);
        await ev(`document.querySelector('#team-panel-goals #goal-tab-comments').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-goals .goal-comments .ac-card').length === 1`, 'the thread on a phone', 15000);
        assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true, 'no sideways scroll');
        assert.equal(await ev(`(() => { const p = document.querySelector('#team-panel-goals .goal-comments > .ac-panel'); return getComputedStyle(p).position === 'static' && getComputedStyle(p).transform === 'none'; })()`), true, 'the panel is in the tab, not a bottom sheet');
        console.log('   ✓');
        console.log('PASS goal comments: the tab, a comment with a picture, Resolve and Reopen, the count, a reload, a phone');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
