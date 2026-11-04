// #13116: a link to one file of Needs you (a push notification) opened after a scan of every team, one after the other, about a second each through the Hub (20 s for the Operator), and a click during a scan waited for
// it and then ran a second. Eight stub teams, each answering after 500 ms: the item is opened from what the Inbox has, or from its own team's read when nothing is loaded (not from a scan of all eight); a scan reads
// at most four teams at once (and is a quarter of the serial time); a scan in flight is joined, not run twice.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const TEAMS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
const HEX = t => (t.charCodeAt(1).toString(16) + 'a').padEnd(64, 'c').slice(0, 64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch, TEAMS = ${JSON.stringify(TEAMS)}, HEX = t => (t.charCodeAt(1).toString(16) + 'a').padEnd(64, 'c').slice(0, 64);
            window.__r = { inflight: 0, max: 0, reads: {}, projects: 0 };
            const later = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the stub team answers after a fixed time, as a team through the Hub does
            const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                if (p === '/api/board/projects') { window.__r.projects++; return Promise.resolve(json(TEAMS.map(t => ({ project: t })))); }
                const m = /^\\/api\\/board\\/(t\\d)\\/artifacts$/.exec(p);
                if (m && url.searchParams.get('tag') === 'saved') return Promise.resolve(json({ artifacts: [], has_more: false }));
                if (m && url.searchParams.get('tag') === 'for review') { const t = m[1]; window.__r.reads[t] = (window.__r.reads[t] || 0) + 1; window.__r.inflight++; window.__r.max = Math.max(window.__r.max, window.__r.inflight);
                    return later(500).then(() => { window.__r.inflight--; return json({ has_more: false, artifacts: [{ id: 'a-' + t, uri: 'coral://artifacts/' + HEX(t), tags: ['for review'], name: t + '.html', created_at: '2026-11-04T00:00:0' + t.slice(1) + 'Z', available: true }] }); }); }
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const S = `(window.__coralStatic || '/static/')`;
        const reset = () => ev(`window.__r.inflight = 0; window.__r.max = 0; window.__r.reads = {}; true`);
        // UI Reviewer's SHOULD: the time is to the requested file's viewer on screen (openNeed does not await openReview, so a no-op would have passed), -1 when it is not there in 6 s
        const viewerShown = team => ev(`(async () => { const t0 = performance.now(); const L = await import(${S} + 'inbox_link.js'); await L.openNeed({ kind: 'review', server: '', team: '${team}', id: '${HEX(team)}' });
            for (;;) { const t = document.querySelector('.artifact-viewer-title'); if (t && t.checkVisibility() && t.textContent === '${team}.html') return Math.round(performance.now() - t0); if (performance.now() - t0 > 6000) return -1; await new Promise(r => setTimeout(r, 20)); } // sleep-ok: polling for the viewer to appear
        })()`);
        const time = expr => ev(`(async () => { const t0 = performance.now(); await (${expr}); return Math.round(performance.now() - t0); })()`);

        // 1: a link when nothing is loaded: the item's own team is read, not all eight (one team: 500 ms)
        // coral-hub's worst case (#13151): the first full scan is still running (the sidebar counts still 0) when the click comes
        await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); window.__scan = M.refreshReviews(true); return true; })()`);
        const cold = await viewerShown('t3');
        console.log(`cold link: the viewer of t3.html on screen after ${cold} ms`);
        assert.ok(cold >= 0, "the requested file's viewer is on screen");
        assert.ok(cold < 1500, `a link opens from its own team's read, not a scan of eight teams (500 ms each): ${cold} ms`);
        await waitFor(`!window.__r.inflight`, 'the background scan ends', 15000);
        assert.ok((await ev(`window.__r.reads.t3`)) >= 1, 'the named team was read');
        // the click joined the scan in flight: no team but the clicked one was read twice (the click's own team read and the viewer's reads of its file are on t3 only)
        const counts = await ev(`window.__r.reads`);
        for (const t of TEAMS.filter(t => t !== 't3')) assert.equal(counts[t], 1, `${t} was read once: a click during the first scan did not start a second scan behind it: ${JSON.stringify(counts)}`);

        // 2: a scan reads at most four teams at once and takes about two rounds, not eight
        await reset();
        const scan = await time(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); await M.refreshReviews(true); })()`);
        const max = await ev(`window.__r.max`);
        console.log(`scan ${scan} ms, at most ${max} teams at once`);
        assert.ok(max <= 4 && max >= 2, `teams are read a few at a time, at most four: ${max}`);
        assert.ok(scan < 2400, `eight teams at 500 ms take about two rounds, not eight (4 s serial): ${scan} ms`);

        // 3: a scan in flight is joined: two forced refreshes at once read each team once
        await reset();
        await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); const a = M.refreshReviews(true), b = M.refreshReviews(true); await Promise.all([a, b]); return true; })()`);
        const reads = await ev(`window.__r.reads`);
        assert.deepEqual(Object.values(reads), TEAMS.map(() => 1), `each team is read once for two requests made together: ${JSON.stringify(reads)}`);

        // 4: with the Inbox loaded, a link opens at once (the scan after it is in the background)
        await reset();
        const warm = await viewerShown('t5');
        console.log(`warm link: the viewer of t5.html on screen after ${warm} ms`);
        assert.ok(warm >= 0, "the requested file's viewer is on screen");
        assert.ok(warm < 400, `a link opens from the rows in hand, no scan first: ${warm} ms`);
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
