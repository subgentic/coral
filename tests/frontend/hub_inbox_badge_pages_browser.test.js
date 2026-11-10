// #15010 (3), from #14780: through the Hub the Inbox badge read '9+' on the Inbox page and '1' on Computers. One pile of pending files on one computer (12), the badge read on every page
// the person can be on: the number is the same (9+, from 12) and its accessible name says the same count.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const FILES = 12;
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1440, height: 900, mobile: false, inbox: process.env.HUB_NATIVE === '1' });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            const real = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            const hex = i => (i + 1).toString(16).padStart(2, '0').repeat(32);
            const rows = Array.from({ length: ${FILES} }, (_, i) => ({ board_id: 'team-1', id: hex(i), uri: 'coral://artifacts/' + hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', source: 'upload', available: true, size: 32, produced_by: 'Dev', created_at: new Date(Date.UTC(2026, 10, 8) - i * 1000).toISOString(), tags: ['for review'] }));
            window.__badgeAsked = [];
            window.fetch = (u, o = {}) => {
                const url = new URL(String(u), location.href), p = url.pathname; window.__badgeAsked.push(p + url.search);
                const page = window.__reviewFixturePage(u, location.href, p.startsWith('/api/remote/m1/') ? { 'team-1': rows } : {});
                if (page) return json(page);
                if (p === '/api/remote/m1/api/board/projects') return json([{ project: 'team-1', board_label: 'Team one', message_count: 1, subscriber_count: 1 }]);
                if (p === '/api/remote/m1/api/board/team-1/artifacts') { const tag = url.searchParams.get('tag'); return json({ project: 'team-1', artifacts: tag && tag !== 'for review' ? [] : rows, has_more: false, total: rows.length }); }
                return real(u, o);
            };
        })()` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'settings');
        const badge = `(() => { const b = document.getElementById('nav-tab-hub-inbox-badge'), t = document.getElementById('nav-tab-hub-inbox'); return { text: b ? b.textContent : null, hidden: b ? b.hidden : null, name: t ? t.getAttribute('aria-label') : null }; })()`;
        await waitFor(`(document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent === '9+'`, 'the badge counts the 12 files the computer holds', 15000);
        const seen = {};
        for (const [page, open] of [['Computers (first paint)', null], ['Inbox', `window.switchNavTab('hub-inbox'); import(${S}+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`], ['Computers', `window.switchNavTab('servers'); true`], ['Agents', `window.switchNavTab('agents'); true`], ['Inbox again', `window.switchNavTab('hub-inbox'); true`]]) {
            if (open) await ev(open);
            await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the page's own reads finish before the badge is read
            seen[page] = await ev(badge);
            console.log(`   ${page}: ${JSON.stringify(seen[page])}`);
        }
        for (const [page, b] of Object.entries(seen)) {
            assert.equal(b.text, '9+', `${page}: the badge says 9+ for ${FILES} files (${JSON.stringify(b)})`);
            assert.match(b.name || '', new RegExp(`${FILES} need your attention`), `${page}: its name says the exact count (${b.name})`);
        }
        console.log('PASS the Inbox badge is the same on every page through the Hub');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exitCode = 1; });
