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
        await setupHubWorld({ client, Page, Emulation, width: 1440, height: 900, mobile: false, inbox: process.env.HUB_NATIVE === '1' });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch, json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.__requests = []; window.__puts = [];
            const boards = Array.from({ length: ${BOARDS} }, (_, i) => 'team-' + (i + 1));
            window.__files = boards.map((b, i) => ({ id: String(i + 1).repeat(64), uri: 'coral://artifacts/' + String(i + 1).repeat(64), name: 'plan-' + (i + 1) + '.md', media_type: 'text/markdown', source: 'upload', available: true, size: 32, produced_by: 'Writer ' + (i + 1), session_id: 's' + (i + 1), tags: ['for review'], created_at: new Date(Date.now() - i * 1000).toISOString(), task_id: 7 }));
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
        // each way of opening one file: the viewer (team-1), a preview (team-2) and a task's artifact list (team-3). One click reads its own board's list only (20 requests over 9 boards before #13489).
        const clicks = {
            viewer: [1, 'team-1', `import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer('${HEX(1)}', { server: 'm1', board: 'team-1', filename: 'plan-1.md', mediaType: 'text/markdown' })).then(() => true)`],
            preview: [2, 'team-2', `import(${S}+'artifact_preview.js').then(m => { const b = document.createElement('div'); document.body.append(b); return m.renderArtifact(b, 'coral://artifacts/${HEX(2)}', { server: 'm1', board: 'team-2', filename: 'plan-2.md', mediaType: 'text/markdown' }, { signal: new AbortController().signal, isStale: () => false }); }).then(() => true)`],
            task: [3, 'team-3', `import(${S}+'team_task_artifacts.js').then(async m => { const links = await m.taskResultLinks('@m1/team-3', { id: 7 }); const host = document.createElement('div'); host.id = 'task-links'; host.append(...links); document.body.append(host); host.querySelector('button').click(); return true; })`],
        };
        for (const [how, [n, board, open]] of Object.entries(clicks)) {
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`); // the viewer of the step before is closed: its own late reads are not this click's
            await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the step before has finished its reads
            await ev(`window.__requests.length = 0; window.__puts.length = 0; true`);
            await ev(open);
            await waitFor(`window.__files[${n - 1}].tags.includes('read')`, `opening the file by ${how} marks it read`, 15000);
            await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the scan a click used to start finishes before it is counted
            const lists = (await ev(`window.__requests.slice()`)).filter(r => /\/artifacts\?tag=/.test(r));
            const boardsRead = new Set(lists.map(r => /board\/(team-\d+)\//.exec(r)?.[1]));
            assert.ok(boardsRead.size <= 1 && (boardsRead.size === 0 || boardsRead.has(board)), `${how}: one click read the review lists of ${boardsRead.size} boards (${lists.length} list requests: ${lists.join(' , ')}); the file's own board is enough`);
            assert.ok(lists.length <= 3, `${how}: one click made ${lists.length} review/saved list requests: ${lists.join(' , ')}`);
            assert.equal(await ev(`window.__puts.length`), 1, `${how}: the file was tagged read once`);
            const reqs = await ev(`window.__requests.slice()`); // the 404s the Hub's operator saw: each is asked at most once per open, and a 404 draws nothing again (UI Accessibility's SHOULD on #13489)
            assert.ok(reqs.filter(r => /\/versions$/.test(r.split('?')[0])).length <= 1, `${how}: versions asked more than once: ${reqs.filter(r => /\/versions/.test(r)).join(' , ')}`);
            assert.ok(reqs.filter(r => /\/comments\?/.test(r)).length <= 1, `${how}: comments asked more than once: ${reqs.filter(r => /\/comments/.test(r)).join(' , ')}`);
        }
        console.log(`PASS opening one file (viewer, preview, a task's list) reads its own board only${process.env.HUB_NATIVE === '1' ? ' (the Hub-served Inbox)' : ''}`);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
