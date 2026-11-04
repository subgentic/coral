// #13160 (the Operator: 'scrolling down on the artifacts page, the window is randomly jumping to the top'), the case where a Hub turns a page away: scrolling into the end of what is loaded asks for the next 100; the computer (through a Hub that
// allows 8 requests in flight) answers 503 once. The list the person is in must stay where it is (its rows, its scroll position, its top row), say so quietly and offer Retry, and Retry must bring the page without moving the list.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => {
    const real = window.fetch; window.__all = 1000; window.__extra = 0; window.__reads = 0;
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    const row = i => ({ id: String(i + 1).padStart(64, '0'), name: 'report-' + String(i).padStart(3, '0') + '.md', media_type: 'text/markdown', size: 100 + i, created_at: new Date(Date.UTC(2026, 10, 4) - i * 60000).toISOString(), task_id: 20 + i, task_title: 'Task ' + i, source: 'task', tags: [], available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha' });
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), p = url.pathname;
        if (p === '/api/team-artifacts' && (o.method || 'GET').toUpperCase() === 'GET') {
            const limit = Math.min(window.__cap || 100, Number(url.searchParams.get('limit') || 100)), total = 1000 + window.__extra; // a computer of Coral 2.0.43 answers what was asked (the page asks 100); window.__cap = 50 is the one with the cap
            if (limit === 1) return json({ artifacts: [row(0)], limit, offset: 0, has_more: true, truncated: false, total, all: window.__all, teams: [{ board_id: 'alpha', team: 'alpha', all: window.__all }] });
            window.__reads++;
            const cursor = url.searchParams.get('cursor'); if (window.__refuse && cursor === window.__refuse) { window.__refuse = ''; window.__refused = (window.__refused || 0) + 1; return json({ error: 'busy' }, 503); }
            const start = cursor ? Number(cursor) : Number(url.searchParams.get('offset') || 0);
            const rows = []; for (let i = start; i < Math.min(total, start + limit); i++) rows.push(row(i));
            const more = start + rows.length < total;
            return json({ artifacts: rows, limit, offset: start, has_more: more, ...(more ? { next_cursor: String(start + rows.length) } : {}), truncated: false, total, all: window.__all, teams: [{ board_id: 'alpha', team: 'alpha', all: window.__all }] });
        }
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw the trigger caused would have happened by now; only waiting shows that nothing moved
    const ROWS = '#group-table-view tbody tr';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${STUB}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${ROWS}').length >= 40`, at + 'the first page', 15000);
            await settle(700);
            await ev(`window.__scroller = () => { let e = document.querySelector('${ROWS}'); while (e && !(e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))) e = e.parentElement; return e || document.scrollingElement; }; true`); // whichever box scrolls: an element or the page itself
            const state = () => ev(`(() => { const v = window.__scroller(), top = v === document.scrollingElement ? 0 : v.getBoundingClientRect().top; const r = [...document.querySelectorAll('${ROWS}')].find(e => e.getBoundingClientRect().bottom > top + 40); return { st: Math.round(v.scrollTop), row: r ? r.querySelector('.dt-primary, td')?.textContent.trim().slice(0, 40) : null, n: document.querySelectorAll('${ROWS}').length, el: v === document.scrollingElement ? 'document' : v.className.slice(0, 30) }; })()`);
            const scrollToRow = i => ev(`(() => { const v = window.__scroller(); const row = document.querySelectorAll('${ROWS}')[${i}]; const top = v === document.scrollingElement ? 0 : v.getBoundingClientRect().top; v.scrollTop += row.getBoundingClientRect().top - top; return v.scrollTop; })()`);
            const holds = async (label, trigger, before) => {
                await trigger(); await settle(900);
                const after = await state();
                assert.equal(after.row, before.row, `${at}${label}: the row at the top is still ${before.row}, got ${after.row} (scrollTop ${before.st} to ${after.st}, scroller ${after.el})`);
                assert.ok(Math.abs(after.st - before.st) <= 3, `${at}${label}: scrollTop stayed ${before.st}, got ${after.st}`);
            };

            // the first page: a page of rows; scroll to the end of it, where the footer asks for the next page; the computer refuses that page once
            const n = await ev(`document.querySelectorAll('${ROWS}').length`);
            assert.ok(n >= 90 && n <= 100, at + `the first page has a page of rows: ${n}`);
            await ev(`window.__refuse = '${n}'; window.__refused = 0; true`);
            await scrollToRow(n - 6); await settle(300);
            await ev(`(() => { const v = window.__scroller(); v.scrollTop = v.scrollHeight; return true; })()`);
            await waitFor(`window.__refused >= 1`, at + 'the next page was asked for and the computer refused it', 10000);
            await settle(900);
            const refused = await state();
            assert.ok(refused.n >= n, `${at}the rows stayed after the refusal: ${n} then ${refused.n}`);
            assert.ok(refused.st > 300, `${at}the list kept its place after the refusal (scrollTop ${refused.st}, scroller ${refused.el}), it did not go back to the top`);
            assert.notEqual(refused.row, 'report-000', `${at}the first row is not the one at the top after the refusal`);
            assert.ok(await ev(`!!document.querySelector('.team-artifacts-retry')`), at + 'Retry is offered');
            // Retry: the page arrives and the list stays where it was
            await ev(`document.querySelector('.team-artifacts-retry').click(); true`);
            await waitFor(`document.querySelectorAll('${ROWS}').length > ${n}`, at + 'Retry brought the next page', 10000);
            await settle(500);
            const retried = await state();
            assert.ok(retried.st > 300 && retried.row !== 'report-000', `${at}after Retry the list is where it was (scrollTop ${retried.st}, top row ${retried.row}), rows ${n} to ${retried.n}`);
            const before = retried;
            console.log(`   ok ${at}(${n} rows, scroller ${before.el})`);
        }
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
