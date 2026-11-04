// #13489: through the Hub, opening ONE file must not read every board's review lists. The first open used to start a full Needs you scan (tag=for review on every board, tag=saved on
// the ones with saved files) because markOpenedRead activated the whole scan; the Hub's operator saw x9 and x7 requests for one click. A file's open reads its own board only.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const HEX = n => String(n).repeat(64);
const BOARDS = 9;
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1440, height: 900, mobile: false, inbox: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch, json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.__requests = []; window.__puts = [];
            const boards = Array.from({ length: ${BOARDS} }, (_, i) => 'team-' + (i + 1));
            window.__files = boards.map((b, i) => ({ id: String(i + 1).repeat(64), uri: 'coral://artifacts/' + String(i + 1).repeat(64), name: 'plan-' + (i + 1) + '.md', media_type: 'text/markdown', source: 'upload', available: true, size: 32, produced_by: 'Writer ' + (i + 1), session_id: 's' + (i + 1), tags: ['for review'], created_at: new Date(Date.now() - i * 1000).toISOString() }));
            window.fetch = (u, o = {}) => {
                const url = new URL(String(u), location.href), p = url.pathname; window.__requests.push(p + url.search);
                if (p === '/api/remote/m1/api/board/projects') return json(boards.map(b => ({ project: b, board_label: b, message_count: 1, subscriber_count: 1 })));
                if (/^\\/api\\/remote\\/m2\\/api\\/board\\/projects$/.test(p)) return json([]);
                const t = /^\\/api\\/remote\\/m1\\/api\\/board\\/(team-\\d+)\\/artifacts(?:\\/([a-f0-9]{64})\\/tags)?$/.exec(p);
                if (t && (o.method || 'GET') === 'PUT') { const a = window.__files.find(a => a.id === t[2]); a.tags = JSON.parse(o.body).tags; window.__puts.push(p); return json({ tags: a.tags }); }
                if (t) { const tag = url.searchParams.get('tag'), i = boards.indexOf(t[1]); const rows = window.__files.filter((a, k) => k === i && (!tag || a.tags.includes(tag))); return json({ project: t[1], artifacts: rows, has_more: false, total: rows.length, tag_counts: { 'for review': rows.length } }); }
                if (/\\/api\\/artifacts\\/[a-f0-9]{64}\\/(comments|versions)/.test(p)) return json({ error: 'not found' }, 404);
                if (/\\/api\\/artifacts\\/[a-f0-9]{64}$/.test(p)) return Promise.resolve(new Response('# plan', { headers: { 'content-type': 'text/markdown' } }));
                return real(u, o);
            };
        })()` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'settings');
        assert.equal(await ev(`import(${S}+'server_base.js').then(m => m.isCloud())`), true, 'a real cloud boot');
        await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the page's own start-up reads finish before the click is counted
        await ev(`window.__requests.length = 0; true`);
        await ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer('${HEX(1)}', { server: 'm1', board: 'team-1', filename: 'plan-1.md', mediaType: 'text/markdown' })).then(() => true)`);
        await waitFor(`window.__files[0].tags.includes('read')`, 'opening the file marks it read', 15000);
        await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the scan a click used to start finishes before it is counted
        const reqs = await ev(`window.__requests.slice()`);
        const lists = reqs.filter(r => /\/artifacts\?tag=/.test(r));
        const boardsRead = new Set(lists.map(r => /board\/(team-\d+)\//.exec(r)?.[1]));
        assert.ok(boardsRead.size <= 1, `one click read the review lists of ${boardsRead.size} boards (${lists.length} list requests); the file's own board is enough`);
        assert.ok(lists.length <= 2, `one click made ${lists.length} review/saved list requests`);
        assert.ok(await ev(`window.__puts.length`) === 1, 'the file was tagged read once');
        console.log(`PASS opening one file reads its own board only (${lists.length} list requests, ${boardsRead.size} board)`);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
