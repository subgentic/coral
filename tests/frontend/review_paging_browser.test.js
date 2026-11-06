// #13958: bounded protected reads, independent cursors, off-page facets and server attention totals.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');

function installReviews() {
    const real = window.fetch;
    const computers = [{ id: 'box-b', label: 'Other computer', status: 'online', owner_stamp: true }];
    const RealSocket = window.WebSocket;
    window.WebSocket = class extends RealSocket {
        constructor(url, ...args) {
            super(url, ...args);
            if (new URL(url, location.href).pathname === '/ws/coral') this.addEventListener('message', event => {
                const data = JSON.parse(event.data);
                if (data.type === 'coral_update') { data.servers = computers; data.sessions = []; Object.defineProperty(event, 'data', { value: JSON.stringify(data) }); }
            });
        }
    };
    window.__reviewRequests = [];
    window.__failReviewMore = false;
    window.__failReviewCount = false;
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    const make = (server, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), board_id: 'alpha', team: 'Product', name: `Entry ${String(i).padStart(3, '0')} ${server}.md`,
        uri: 'coral://artifacts/' + (i + 1).toString(16).padStart(64, '0'), media_type: 'text/markdown', size: 40, available: true,
        produced_by: i === 64 ? 'Off-page writer' : `Writer ${i}`, session_id: `writer-${i}`, series_id: `series-${i}`, version: i === 0 ? 2 : 1, opened_version: i === 0 ? 1 : 0,
        tags: ['for review', ...(i < 50 || (i === 64 && server === 'local') ? ['read'] : []), ...(i === 1 || i === 2 ? ['changes requested'] : [])], new_comments: i === 2 ? 1 : 0,
        created_at: new Date(Date.UTC(2026, 10, 6, 12, 0, i)).toISOString(), ...(i === 64 ? { goal_id: 77, goal_title: 'Off-page goal' } : {}) });
    window.fetch = (input, options) => {
        const url = new URL(String(input), location.href), path = url.pathname;
        const server = path.startsWith('/api/remote/box-b/') ? 'box-b' : 'local';
        if (path === '/api/health') return json({ hub: true });
        if (path === '/api/sessions/live') return json({ sessions: [], servers: computers });
        if (path.endsWith('/api/board/projects')) return json([{ project: 'alpha', board_label: 'Product' }]);
        if (path.endsWith('/api/operator-asks')) return json([]);
        if (path.endsWith('/api/team-artifacts') || path.endsWith('/api/board/alpha/artifacts') || path.endsWith('/api/board/~no-team/artifacts')) {
            const params = url.searchParams, cursor = params.get('cursor') || '', limit = Number(params.get('limit') || 50);
            window.__reviewRequests.push({ server, cursor, limit, query: params.toString() });
            if (params.get('tag') === 'saved' || params.get('team') === '~no-team') return json({ artifacts: [], total: 0, tag_counts: {}, has_more: false });
            let all = Array.from({ length: 65 }, (_, i) => make(server, i));
            if (params.get('q')) all = all.filter(a => a.name.toLowerCase().includes(params.get('q').toLowerCase()));
            if (params.get('by')) all = all.filter(a => a.produced_by === params.get('by'));
            if (params.get('goal')) all = all.filter(a => a.goal_id === Number(params.get('goal')));
            if (params.get('digest')) all = all.filter(a => params.get('digest').split(',').includes(a.id));
            if (params.get('waiting') === '1') {
                if (server === 'box-b' && window.__failReviewCount) return json({ error: 'offline' }, 503);
                const total = params.get('q') || params.get('goal') || params.get('by') ? all.filter(a => a.new_comments > 0 || (!a.tags.includes('changes requested') && (!a.tags.includes('read') || a.opened_version > 0 && a.version > a.opened_version))).length : server === 'local' ? 16 : 17;
                return json({ artifacts: [], total, has_more: false });
            }
            if (cursor && server === 'box-b' && window.__failReviewMore) return json({ error: 'offline' }, 503);
            if (cursor && cursor !== `${server}:50`) return json({ error: 'wrong computer cursor' }, 400);
            const start = cursor ? 50 : 0, rows = all.slice(start, start + limit), more = start + rows.length < all.length;
            return json({ artifacts: rows, total: all.length, teams: [{ board_id: 'alpha', team: 'Product' }], tag_counts: { 'for review': all.length }, has_more: more,
                ...(more ? { next_cursor: `${server}:50` } : {}), facets: { team: [{ v: 'Product', n: 65 }], by: [{ v: 'Off-page writer', n: 1 }], goal: [{ v: 'Off-page goal', id: 77, n: 1 }] } });
        }
        if (path.startsWith('/api/remote/box-b/')) return json([]);
        return real(input, options);
    };
}

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(${installReviews.toString()})()` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const first = await ev(`(async () => {
            localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral-inbox-group-review-goal');
            const { state } = await import(${S} + 'state.js'); state.hub = true; state.serversKnown = true;
            state.servers = [{ id: 'box-b', label: 'Other computer', status: 'online', owner_stamp: true }]; state.liveSessions = [];
            state.settings = { ...state.settings, inbox_welcome: 'off' };
            window.__R = await import(${S} + 'inbox_reviews.js'); await window.__R.refreshReviews(true);
            return { loaded: window.__R.reviewItems().length, cursors: window.__reviewRequests.filter(r => r.cursor).length };
        })()`);
        assert.equal(first.loaded, 100, 'opening loads only the first 50 review files per computer');
        assert.equal(first.cursors, 0, 'no cursor page is read before Show more');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs'))`);
        await waitFor(`document.querySelector('[data-review-more="box-b"]')`, 'per-computer Show more');
        await ev(`(async () => { window.__C = await import(${S} + 'review_counts.js'); await window.__C.refreshCounts(true); (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
        await waitFor(`/33 need your attention/.test(document.getElementById('nav-tab-hub-inbox').getAttribute('aria-label') || '')`, 'badge uses 33 server attention items, not loaded unread rows');
        assert.equal(await ev(`window.__R.unreadReviewItems().length`), 4, 'loaded page attention includes the new unopened version and news, excludes quiet changes requests');
        await waitFor(`[...document.querySelectorAll('#group-table-view button')].some(b => /^For review\\s*33$/.test(b.textContent.trim()))`, 'For review pill uses the same server total');
        await ev(`window.__hiddenReviewTab = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hiddenReviewTab }); document.dispatchEvent(new Event('visibilitychange')); true`);
        await waitFor(`/^\\(33\\) /.test(document.title)`, 'background title uses the server total');
        await ev(`window.__hiddenReviewTab = false; document.dispatchEvent(new Event('visibilitychange')); true`);
        assert.ok(await ev(`[...document.querySelectorAll('#inbox-needs-agent option')].some(o => o.value === 'Off-page writer')`), 'UI offers an agent present only in server facets beyond page one');
        const goals = await ev(`[...document.querySelectorAll('#inbox-needs-goal option')].map(o => o.value).filter(v => /Off-page goal/.test(v))`);
        assert.equal(new Set(goals).size, 2, 'same goal title and number on two computers stays two choices');
        await ev(`window.__failReviewCount = true; window.__C.refreshCounts(true).then(() => import(${S} + 'inbox_tab.js')).then(m => m.updateInboxTab())`);
        await waitFor(`/at least 18 need your attention/.test(document.getElementById('nav-tab-hub-inbox').getAttribute('aria-label') || '')`, 'partial count adds only failed-source loaded rows');
        await waitFor(`[...document.querySelectorAll('#group-table-view button')].some(b => b.textContent.includes('For review') && b.textContent.includes('at least 18'))`, 'partial pill uses the same lower bound');
        await ev(`window.__failReviewCount = false; window.__C.refreshCounts(true).then(() => import(${S} + 'inbox_tab.js')).then(m => m.updateInboxTab())`);
        await ev(`window.__failReviewMore = true; document.querySelector('[data-review-more="box-b"][data-review-stream="review"]').click(); true`);
        await waitFor(`/Retry/.test(document.querySelector('[data-review-more="box-b"][data-review-stream="review"]')?.textContent || '')`, 'failed cursor offers Retry');
        assert.equal(await ev(`window.__R.reviewItems().length`), 100, 'append failure preserves loaded rows');
        await ev(`window.__failReviewMore = false; document.querySelector('[data-review-more="box-b"][data-review-stream="review"]').focus(); document.querySelector('[data-review-more="box-b"][data-review-stream="review"]').click(); true`);
        await waitFor(`window.__R.reviewItems().length === 115`, 'only the selected computer appends its next page');
        assert.equal(await ev(`window.__R.reviewPages().find(p => p.server === 'local').next_cursor`), 'local:50');
        assert.ok(await ev(`window.__reviewRequests.filter(r => r.cursor).every(r => r.server === 'box-b' && r.cursor === 'box-b:50')`), 'failure and retry reuse only the selected source cursor');
        await ev(framesJs(2));
        assert.equal(await ev(`document.activeElement.id`), 'group-table-title', 'exhausting a keyboard paging button preserves a useful focus target');
        await ev(`(() => { const q = document.getElementById('inbox-search'); q.value = 'Entry 064'; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`window.__R.reviewQueryState()?.shown === 2`, 'off-page search is answered by the computers, not a loaded-page filter');
        await waitFor(`[...document.querySelectorAll('#group-table-view button')].some(b => b.textContent.includes('For review') && b.textContent.trim().endsWith('1'))`, 'filtered pill uses filtered server attention');
        await ev(`(() => { const q = document.getElementById('inbox-search'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelector('[data-review-more="local"][data-review-stream="review"]') && window.__R.reviewQueryState() === null`, 'clearing a query restores its retained unfiltered window and cursor');
        for (const [width, font, theme] of [[1280, 16, 'dark'], [390, 32, 'light']]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
            await ev(`document.documentElement.style.fontSize = '${font}px'; document.documentElement.dataset.theme = '${theme}'; true`);
            await ev(framesJs(2));
            const target = await ev(`(() => { const b = document.querySelector('[data-review-more="local"][data-review-stream="review"]'), r = b.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, viewport: innerWidth }; })()`);
            assert.ok(target.width > 0 && target.left >= 0 && target.right <= target.viewport + 1, `Show more remains on screen at ${width}/${font}/${theme}: ${JSON.stringify(target)}`);
        }
        console.log('PASS bounded review pages, protected cursor retry, off-page facets, and badge/title/pill totals with partial-source handling');
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
