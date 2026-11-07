// #13501 (UI Accessibility's SHOULD on #13489): the same one-team open on a local Coral (no Hub, no server): markOpenedRead(hex, team) reads that team's review list once, tags the file read once, and never lists the boards.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const HEX = String(5).repeat(64);
(async () => {
    const { client, Page, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch, json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.__requests = []; window.__puts = [];
            window.__file = { board_id:'team-1', id: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'plan.md', media_type: 'text/markdown', source: 'upload', available: true, size: 32, produced_by: 'Writer', session_id: 's1', tags: ['for review'], created_at: new Date().toISOString() };
            window.fetch = (u, o = {}) => {
                const url = new URL(String(u), location.href), p = url.pathname; window.__requests.push(p + url.search);
                const page = p === '/api/team-artifacts' ? window.__reviewFixturePage(u, location.href, {'team-1':[window.__file]}) : null;
                if (page) return json(page);
                if (p === '/api/board/projects') return json([{ project: 'team-1', board_label: 'team-1', message_count: 1, subscriber_count: 1 }, { project: 'team-2', board_label: 'team-2', message_count: 1, subscriber_count: 1 }]);
                const t = /^\\/api\\/board\\/(team-\\d+)\\/artifacts(?:\\/([a-f0-9]{64})\\/tags)?$/.exec(p);
                if (t && (o.method || 'GET') === 'PUT') { window.__file.tags = JSON.parse(o.body).tags; window.__puts.push(p); return json({ tags: window.__file.tags }); }
                if (t) { const tag = url.searchParams.get('tag'); const rows = t[1] === 'team-1' && (!tag || window.__file.tags.includes(tag)) ? [window.__file] : []; return json({ project: t[1], artifacts: rows, has_more: false, total: rows.length }); }
                return real(u, o);
            };
        })()` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'settings');
        assert.equal(await ev(`import(${S}+'server_base.js').then(m => m.isCloud())`), false, 'a local Coral, not the Hub');
        await ev(`window.__requests.length = 0; true`);
        await ev(`import(${S}+'inbox_reviews.js').then(m => m.markOpenedRead('${HEX}', 'team-1')).then(() => true)`);
        await waitFor(`window.__file.tags.includes('read')`, 'the file is tagged read', 10000);
        const reqs = await ev(`window.__requests.slice()`);
        assert.equal(reqs.filter(r => /^\/api\/board\/projects/.test(r)).length, 0, 'no board list: ' + reqs.join(' , '));
        const pages = reqs.filter(r => new URL(r, BASE).pathname === '/api/team-artifacts' && new URL(r, BASE).searchParams.has('digest'));
        assert.equal(pages.length, 1, 'one protected exact-file read: ' + reqs.join(' , '));
        const totals = reqs.filter(r => new URL(r, BASE).pathname === '/api/team-artifacts' && !new URL(r, BASE).searchParams.has('digest'));
        assert.ok(totals.every(r => {const q=new URL(r,BASE).searchParams;return q.get('limit')==='1' && q.get('waiting')==='1' && q.get('muted')==='0' && q.get('versions')==='newest' && q.get('tag')==='for review' && [...q].length===5;}), 'any independent badge total stays bounded');
        const query = new URL(pages[0], BASE).searchParams;
        assert.equal(query.get('team'), 'team-1'); assert.equal(query.get('digest'), HEX); assert.equal(query.get('tag'), 'for review'); assert.equal(query.get('limit'), '50'); assert.equal(query.has('cursor'), false);
        assert.equal(reqs.filter(r => /\/board\/team-\d+\/artifacts\?/.test(r)).length, 0, 'no old per-board scan');
        assert.equal(await ev(`window.__puts.length`), 1, 'tagged read once');
        console.log('PASS local Coral: opening a file reads its own team once and tags it read once');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
