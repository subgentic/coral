// #13161: a computer answers at most 50 artifacts a request, and the page asks for the next 50: every walk of a team's artifacts (the Needs you scan, the viewer's review state, the tags read before a write) advances by
// what the computer returned and its cursor, not by the 200 an older page asked for. A stub team of 130 files for review answers 50 at a time with a cursor (a new computer) or whole pages of up to 200 with no cursor
// (an older one): every file is found either way, none twice.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const N = 130;
const hexOf = i => String(i + 1).padStart(64, 'a').replace(/^a+/, m => m.replace(/a/g, '0')).slice(-64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch, N = ${N}; window.__mode = 'new'; window.__calls = [];
            const hex = i => String(i + 1).padStart(64, '0');
            const art = i => ({ id: 'a-' + i, uri: 'coral://artifacts/' + hex(i), tags: ['for review'], name: 'file-' + String(i).padStart(3, '0') + '.html', created_at: new Date(Date.UTC(2026, 10, 4, 0, 0, 0) - i * 1000).toISOString(), available: true, produced_by: 'Dev', session_id: 's-' + i });
            const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                if (p === '/api/board/projects') return json([{ project: 't1' }]);
                if (p === '/api/board/t1/artifacts') { const tag = url.searchParams.get('tag'); window.__calls.push(url.search);
                    if (tag !== 'for review') return json({ has_more: false, artifacts: [] });
                    const cap = window.__mode === 'new' ? 50 : 200, asked = Number(url.searchParams.get('limit') || 100), limit = Math.min(asked, cap);
                    const cursor = url.searchParams.get('cursor'), start = cursor ? Number(cursor) : Number(url.searchParams.get('offset') || 0);
                    const page = []; for (let i = start; i < Math.min(N, start + limit); i++) page.push(art(i));
                    const more = start + page.length < N;
                    return json({ artifacts: page, limit, offset: start, has_more: more, ...(window.__mode === 'new' && more ? { next_cursor: String(start + page.length) } : {}), total: N }); }
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const S = `(window.__coralStatic || '/static/')`;
        for (const mode of ['new', 'old']) {
            await ev(`window.__mode = '${mode}'; window.__calls.length = 0; true`);
            const found = await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); await M.refreshReviews(true); const names = M.reviewItems().map(a => a.name); return { n: names.length, distinct: new Set(names).size }; })()`);
            assert.deepEqual(found, { n: N, distinct: N }, `${mode} computer: the scan finds all ${N} files, each once: ${JSON.stringify(found)}`);
            const sizes = await ev(`window.__calls.filter(c => /tag=for/.test(c)).length`);
            if (mode === 'new') assert.ok(sizes >= 3, `a computer of 50 a page took ${sizes} reads of for review for 130 files`);
            const state = await ev(`(async () => { const R = await import(${S} + 'artifact_review.js'); const s = await R.reviewStateOf('t1', '${'0'.repeat(61)}120'); return s ? s.state : null; })()`);
            assert.equal(state, 'pending', `${mode} computer: a file on page 3 has its review state read (it was past page 1 and 2)`);
            const tags = await ev(`(async () => { const M = await import(${S} + 'inbox_reviews.js'); return M.currentTags({ team: 't1', id: 'a-119' }); })()`);
            assert.deepEqual(tags, ['for review'], `${mode} computer: the tags of file 119 are read (on page 3)`);
        }
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
