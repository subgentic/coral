// #13293: after warmup, a real 60-second idle window must make no artifact
// list reads. Run the real cache/page timers against deterministic responses;
// then prove upload, reconnect, legacy and failed-status fallback behavior.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => {
            const base = window.__coralStatic || '/static/';
            const team = 'idle-artifacts-probe', hex = '1'.repeat(64);
            const probe = window.__artifactIdle = { rev: 1, lists: 0, statuses: 0, legacy: false, fail: false, rows: [] };
            const original = window.fetch;
            const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => {
                const url = new URL(String(u), location.href);
                if (url.pathname === '/api/board/projects') return json([{ project: team }]);
                if (url.pathname === '/api/board/' + team + '/status' || url.pathname === '/api/board/~no-team/status') { probe.statuses++; return probe.fail ? json({}, 503) : json(probe.legacy ? {} : { artifacts_rev: url.pathname.includes('~no-team') ? probe.rev + 1000 : probe.rev, artifacts_all_rev: probe.rev }); }
                if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
                if (url.pathname === '/api/team-artifacts') { probe.lists++; return json({ artifacts: probe.rows.map(a => ({ ...a, board_id: team, team })), teams: [], artifacts_board: team, artifacts_rev: probe.rev, all: probe.rows.length, total: probe.rows.length, has_more: false }); }
                if (url.pathname === '/api/board/' + team + '/artifacts') {
                    probe.lists++;
                    return json({ project: team, artifacts: url.searchParams.get('tag') === 'saved' ? [] : probe.rows, has_more: false, ...(probe.legacy ? {} : { artifacts_rev: probe.rev }) });
                }
                return original(u, o);
            };
            probe.module = await import(base + 'inbox_reviews.js');
            await probe.module.refreshReviews(true);
            const pages = await import(base + 'team_artifacts_page.js');
            await Promise.all([false, true].map(inbox => new Promise(resolve => {
                const root = document.createElement('div'); root.className = 'team-panel'; document.body.append(root);
                const list = pages.createArtifactsList({ inbox });
                list.showArtifacts(root, inbox ? '@inbox' : team, { onCount: resolve });
            })));
            const counts = await import(base + 'inbox_artifacts.js');
            await counts.refreshArtifactCount();
            await ${framesJs(2)};
            probe.lists = 0;
            probe.interval = setInterval(() => { probe.module.refreshReviews(); counts.refreshArtifactCount(); }, 1000);
            probe.hex = hex; probe.team = team;
        })()`);
        console.log('artifacts_idle_browser: observing 60 seconds of unchanged-board idle');
        const idle = await ev(`new Promise(resolve => setTimeout(() => { const p = window.__artifactIdle; clearInterval(p.interval); resolve({ lists: p.lists, statuses: p.statuses }); }, 60000))`);
        assert.equal(idle.lists, 0, 'unchanged board must make zero artifact list reads in 60 s: ' + JSON.stringify(idle));
        assert.ok(idle.statuses > 0, 'freshness is checked, rather than disabling refresh');
        const result = await ev(`(async () => {
            const p = window.__artifactIdle, base = window.__coralStatic || '/static/';
            const feed = await import(base + 'artifacts_feed.js');
            p.rows.push({ id: p.hex, uri: 'coral://artifacts/' + p.hex, name: 'new-upload.md', session_id: 'idle-agent', available: true, tags: ['for review'], created_at: '2026-11-04T00:00:00Z' });
            p.rev++;
            feed.publishArtifactsRev({ [p.team]: p.rev });
            await p.module.refreshReviews();
            const uploaded = p.module.reviewItems().some(a => a.id === p.hex), uploadReads = p.lists;
            p.lists = 0;
            feed.publishArtifactsRev({ [p.team]: p.rev }, true);
            await p.module.refreshReviews();
            await p.module.refreshReviews();
            const reconnectReads = p.lists;
            p.lists = 0; p.legacy = true;
            // A forced user refresh loads a legacy response; later background
            // scans must retain the original 30-second fallback.
            await p.module.refreshReviews(true);
            await p.module.refreshReviews(true);
            p.lists = 0;
            const now = Date.now; Date.now = () => now() + 31000;
            try { await p.module.refreshReviews(); } finally { Date.now = now; }
            const legacyReads = p.lists;
            p.legacy = false; await p.module.refreshReviews(true); p.lists = 0; p.fail = true;
            Date.now = () => now() + 31000;
            try { await p.module.refreshReviews(); } finally { Date.now = now; }
            return { uploaded, uploadReads, reconnectReads, legacyReads, failedStatusReads: p.lists };
        })()`);
        assert.ok(result.uploaded && result.uploadReads >= 2, 'a changed revision loads the new upload: ' + JSON.stringify(result));
        assert.ok(result.reconnectReads >= 2, 'reconnect re-reads even the same revision: ' + JSON.stringify(result));
        assert.ok(result.legacyReads >= 2, 'missing revision keeps polling fallback: ' + JSON.stringify(result));
        assert.ok(result.failedStatusReads >= 2, 'failed freshness check does not freeze cached rows: ' + JSON.stringify(result));
        console.log('artifacts_idle_browser: ok', JSON.stringify({ idle, result }));
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
