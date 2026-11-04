// #13092: a folder whose live git updates are paused (#13079) says so where its change count is shown, with the last count and where to turn the updates on again: the agent header's git chip, the folder group's badge in the
// sidebar and the session card's tooltip. A folder that is not paused is as it was. Drives Chrome over CDP; the live list is the page's mock.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const S = `(window.__coralStatic || '/static/')`;
        const html = await ev(`(async () => {
            const m = await import(${S} + 'session_state.js');
            const paused = m._gitStateSummary({ is_worktree: false, base_branch: '', ahead: 0, behind: 0, dirty: 3, paused: { changes: 35000, took_ms: 3200 } });
            const plain = m._gitStateSummary({ is_worktree: false, base_branch: 'main', ahead: 1, behind: 0, dirty: 3 });
            const clean = m._gitStateSummary({ is_worktree: false, base_branch: 'main', ahead: 0, behind: 0, dirty: 0, paused: { changes: 20, took_ms: 2500 } });
            return { paused, plain, clean };
        })()`);
        assert.match(html.paused, /●3</, `the chip keeps the uncommitted count (3): ${html.paused}`);
        assert.ok(!/●35000/.test(html.paused), `and does not show the comparison's total as uncommitted files: ${html.paused}`);
        assert.match(html.paused, /class="gs-paused"[^>]*>paused: 35000 files in the comparison</, `the paused marker says what its count is: ${html.paused}`);
        assert.ok(html.paused.includes('Refresh') && html.paused.includes('Turn on live updates'), `its hover words say where to go: ${html.paused}`);
        assert.ok(!/gs-paused/.test(html.plain) && /●3/.test(html.plain), `a folder that is not paused is as it was: ${html.plain}`);
        // UI Reviewer's MUST: a clean worktree (dirty 0) with a comparison total is not given uncommitted files
        assert.ok(!/gs-dirty/.test(html.clean) && !/uncommitted/.test(html.clean), `a clean worktree shows no uncommitted count: ${html.clean}`);
        assert.match(html.clean, /paused: 20 files in the comparison/, `only the paused marker, with its total: ${html.clean}`);
        // the sidebar's folder group badge
        await ev(`(() => { localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.agents = {};
            window.__m.add('pausedrepo', 'P', 2, { sleeping: false, session_id: 'pm-1-id' }); window.__m.add('plainrepo', 'Q', 2, { sleeping: false, session_id: 'pm-2-id' });
            window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => { const e = window.__m.entry(a);
                return a.session_id === 'pm-1-id' ? { ...e, changed_file_count: 4, git_state: { is_worktree: false, base_branch: '', ahead: 0, behind: 0, dirty: 4, paused: { changes: 35000, took_ms: 3200 } } } : { ...e, changed_file_count: 2 }; })); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .group-changes').length >= 2`, 'the folder groups draw their badges', 10000);
        const badges = await ev(`[...document.querySelectorAll('#live-sessions-list .group-changes')].map(b => ({ text: b.textContent.trim(), cls: b.className, title: b.title }))`);
        const pausedBadge = badges.find(b => /paused/.test(b.text));
        assert.ok(pausedBadge, `the paused folder's group badge says paused: ${JSON.stringify(badges)}`);
        assert.match(pausedBadge.title, /Refresh or Turn on live updates/, `with where to turn it on: ${pausedBadge.title}`);
        assert.ok(badges.some(b => /^2 changed$/.test(b.text) && !/paused/.test(b.cls)), `and the other folder is as it was: ${JSON.stringify(badges)}`);
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
