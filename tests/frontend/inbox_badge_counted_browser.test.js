// #13172 (slice 2a): the Inbox tab's badge shows the files waiting for the Operator from the first paint, counted by the computer (one limit=1 read of its list), without the Inbox having been opened and without reading a page of any team; once Needs you is
// opened and its full read has run, the badge is that read's number, which is the same here. The computer is a stub: its count says 7, its team holds the same 7 files.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.__asked = [];
            const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const hex = i => (i.toString(16) + 'd').padEnd(64, 'e').slice(0, 64);
            const art = i => ({ id: 'a-' + i, uri: 'coral://artifacts/' + hex(i), tags: ['for review'], name: 'report-' + i + '.md', created_at: new Date(Date.UTC(2026, 10, 4) - i * 1000).toISOString(), available: true, produced_by: 'Dev', session_id: 's-1' });
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname; window.__asked.push(p + url.search);
                if (p === '/api/team-artifacts' && url.searchParams.get('waiting') === '1') return Promise.resolve(json({ total: 7, artifacts: [], has_more: false }));
                if (p === '/api/board/projects') return Promise.resolve(json([{ project: 't1' }]));
                if (p === '/api/board/t1/artifacts') { const tag = url.searchParams.get('tag'); return Promise.resolve(json(tag === 'for review' ? { has_more: false, artifacts: Array.from({ length: 7 }, (_, i) => art(i)) } : { has_more: false, artifacts: [] })); }
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        // 1: the badge says 7 with the Inbox never opened
        await waitFor(`(document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent === '7'`, 'the badge shows the 7 files the computer counted, with no Inbox open', 12000);
        const asked = await ev(`window.__asked`);
        const counts = asked.filter(p => p.startsWith('/api/team-artifacts') && /waiting=1/.test(p));
        assert.equal(counts.length, 1, 'one count read: ' + counts.join(' '));
        for (const w of ['muted=0', 'versions=newest', 'limit=1', 'tag=for%20review']) assert.ok(counts[0].includes(w), `the count read says ${w}: ${counts[0]}`);
        assert.equal(asked.filter(p => /^\/api\/board\/[^/]+\/artifacts/.test(p)).length, 0, 'no page of any team was read to show the badge');
        // 2: the Inbox opened: its full read runs and the badge keeps the same number
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 7`, 'the 7 files are listed', 10000);
        assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), '7', 'the badge is the full read\'s number now, the same');
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exitCode = 1; });
