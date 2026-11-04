// #13304: through Coral Hub one computer allows 8 requests in flight and 503s the rest at once (Retry-After: 2). The page, with every wrapper of window.fetch it installs (the Hub's CSRF, the shared reads, the overload watch),
// must keep to 6 in flight per computer, ask a refused read again, and show Needs you's remote files. A stub Hub under the page's own fetch: it counts what is in flight per computer and refuses past 8.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch;
            window.__hub = { inflight: {}, peak: {}, refused: 0, answered: 0, onceRefused: new Set() };
            const later = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a computer behind the Hub answers after a moment
            const json = (b, status = 200, h = {}) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...h } });
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), m = /^\\/api\\/remote\\/([^/]+)\\//.exec(url.pathname);
                if (!m) return real(u, o);
                const H = window.__hub, k = m[1]; H.inflight[k] = (H.inflight[k] || 0) + 1; H.peak[k] = Math.max(H.peak[k] || 0, H.inflight[k]);
                if (H.inflight[k] > 8) { H.inflight[k]--; H.refused++; return Promise.resolve(json({}, 503, { 'Retry-After': '2' })); }
                if (url.pathname.endsWith('/once-busy') && !H.onceRefused.has(url.search)) { H.onceRefused.add(url.search); H.inflight[k]--; H.refused++; return Promise.resolve(json({}, 503, { 'Retry-After': '2' })); }
                return later(40).then(() => { H.inflight[k]--; H.answered++; return json({ ok: true, path: url.pathname }); }); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        // a page that goes over the cap: 30 reads of one computer at once, as a load does
        const out = await ev(`(async () => { const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch('/api/remote/box-2/api/board/t' + i + '/status'))); return { statuses: [...new Set(rs.map(r => r.status))], peak: window.__hub.peak['box-2'], refused: window.__hub.refused }; })()`);
        console.log('30 reads at once:', JSON.stringify(out));
        assert.deepEqual(out.statuses, [200], 'every read answered 200, none was shown a 503');
        assert.ok(out.peak <= 6, `at most 6 in flight to one computer: ${out.peak}`);
        assert.equal(out.refused, 0, 'the Hub refused none');
        // a read the Hub refused once is asked again and the page gets the answer (the stub says Retry-After: 2, so this takes about 2 s)
        const again = await ev(`(async () => { const r = await fetch('/api/remote/box-2/api/once-busy?x=1'); return { status: r.status, refused: window.__hub.refused }; })()`);
        assert.equal(again.status, 200, 'the refused read was asked again and answered');
        assert.equal(again.refused, 1, 'the Hub did refuse it once');
        // a write is not repeated
        const post = await ev(`(async () => { const before = window.__hub.refused; const r = await fetch('/api/remote/box-2/api/once-busy?x=2', { method: 'POST', body: '{}' }); return { status: r.status, refused: window.__hub.refused - before }; })()`);
        assert.equal(post.status, 503, 'a refused write is the answer, not repeated');
        assert.equal(post.refused, 1, 'it was sent once');
        // another computer is not held up by a full one
        const other = await ev(`(async () => { const t0 = performance.now(); const hold = Array.from({ length: 12 }, () => fetch('/api/remote/box-3/api/slow')); const r = await fetch('/api/remote/box-4/api/quick'); const ms = performance.now() - t0; await Promise.all(hold); return { status: r.status, ms }; })()`);
        assert.equal(other.status, 200);
        assert.ok(other.ms < 400, `box-4 was not queued behind box-3: ${Math.round(other.ms)} ms`);
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exitCode = 1; });
