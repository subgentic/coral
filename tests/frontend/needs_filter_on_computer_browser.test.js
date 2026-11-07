// #13162, Stage 1: Needs you's filters are the computer's for the file rows. 900 files are for review on one team; the page's own read of the whole list is made to stop at 200 (as a computer that only returns its
// first page would leave it), so a match that is item 897 of 900 can only come from the computer's answer to the filter: it is on page 1 of its query. A filter that matches 100 shows the first 50 with 'Showing 50 of 100
// files for review that match' and Show more brings the rest. No filter: the list is the one the page reads, as before. 1280 px, the real page, a stand-in for the team route.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const N = 900;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a read or a redraw that would have happened by now; only waiting shows that it did not
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch, N = ${N}; window.__asked = [];
            const hex = i => String(i + 1).padStart(64, '0');
            const art = i => ({ board_id:'t1', id: 'a-' + i, uri: 'coral://artifacts/' + hex(i), tags: ['for review'], name: 'report-' + String(i).padStart(3, '0') + '.md', created_at: new Date(Date.UTC(2026, 10, 4) - i * 1000).toISOString(), available: true, ...(i === 150 ? {} : { produced_by: 'Dev', session_id: 's-1' }), ...(i === 321 ? { review_question: 'Is the Zulu migration safe to run?' } : {}) });
            const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
                if (p === '/api/board/projects') return json([{ project: 't1' }]);
                if (p === '/api/team-artifacts') {
                    window.__asked.push(url.search);
                    const q = url.searchParams.get('q');
                    const page = window.__reviewFixturePage(u, location.href, {t1:Array.from({length:q?N:200},(_,i)=>art(i))});
                    if (page.next_cursor) (window.__offeredCursors || (window.__offeredCursors=[])).push({q:q||'',cursor:page.next_cursor});
                    return json(page);
                }
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view') && /report-000/.test(document.getElementById('group-table-view').innerText)`, 'Needs you lists the files of the page\'s own read', 15000);
        const text = () => ev(`document.getElementById('group-table-view').innerText.replace(/\\s+/g, ' ')`);
        assert.ok(!/report-897/.test(await text()), 'precondition: file 897 is not in the page\'s own read (it stops at 200)');
        const type = value => ev(`(() => { const i = document.getElementById('inbox-search'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

        // 1: a match past the first 50 is on page 1 of its query
        await type('report-897');
        await waitFor(`/report-897/.test(document.getElementById('group-table-view').innerText)`, 'the match that is item 897 of 900 is shown', 10000);
        const asked = await ev(`window.__asked.filter(s => /q=report-897/.test(s)).length`);
        assert.ok(asked >= 1, `the computer was asked for the search (q=report-897): ${asked} such requests`);

        // 2: a filter that matches 100: the first 50 and Show more
        await type('report-5');
        await waitFor(`/Showing 50 of 100 files for review that match/.test(document.getElementById('group-table-view').innerText)`, 'the count of the filter and the first 50', 10000);
        await ev(`[...document.querySelectorAll('#group-table-view .inbox-more-files button')].find(b => /Show more/.test(b.textContent)).click(); true`);
        await waitFor(`!/Show more/.test(document.getElementById('group-table-view').innerText) || !document.querySelector('#group-table-view .inbox-more-files')`, 'the rest arrives and Show more goes', 10000);
        const pages = await ev(`window.__asked.filter(s => /q=report-5/.test(s)).length`);
        assert.ok(pages >= 2, `the second page was asked for with the cursor: ${pages} requests`);
        assert.ok(await ev(`window.__asked.some(s => /q=report-5/.test(s) && window.__offeredCursors.some(c=>c.q==='report-5'&&c.cursor===new URLSearchParams(s).get('cursor')))`), 'by the cursor the computer gave');

        // 2b: a word only in a file's review question (the page's own search matched it; the computer's must too)
        await type('zulu migration');
        await waitFor(`/report-321/.test(document.getElementById('group-table-view').innerText)`, 'the file whose question holds the words is shown', 10000);
        assert.ok(await ev(`window.__asked.some(s => /q=zulu/.test(s))`), 'and it was the computer that was asked for those words');

        // 3: no filter: the list the page reads, as before
        await type('');
        await waitFor(`/report-000/.test(document.getElementById('group-table-view').innerText)`, 'the unfiltered list is back', 10000);
        assert.ok(await ev(`!!document.querySelector('#group-table-view .inbox-review-more [data-review-more]')`), 'unfiltered reviews retain the bounded page and offer explicit Show more');
        // 4: the agent filter 'Unknown agent' (a file with no producer) is the page's: it is not sent as by=, and the file with no producer is shown
        await ev(`localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ agent: 'Unknown agent' })); true`);
        await ev(`window.__asked.length = 0; true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`import(${S}+'inbox_reviews.js').then(m=>m.reviewQueryState()?.loading===false)`, 'the first locally filtered page');
        assert.ok(!/report-150/.test(await text()), 'the unknown-agent file beyond the first page is not fetched automatically');
        for (const cursor of [50,100,150]) {
            const before = await ev('window.__asked.length');
            await ev(`[...document.querySelectorAll('#group-table-view .inbox-more-files button')].find(b=>/Show more/.test(b.textContent)).click();true`);
            await waitFor(`window.__asked.slice(${before}).some(s=>window.__offeredCursors.some(c=>c.cursor===new URLSearchParams(s).get('cursor')))`, 'explicit page '+cursor);
            await waitFor(`import(${S}+'inbox_reviews.js').then(m=>m.reviewQueryState()?.loading===false)`, 'the requested page settles');
        }
        await waitFor(`/report-150/.test(document.getElementById('group-table-view').innerText)`, 'the file with no producer is shown under Agent: Unknown agent', 10000);
        assert.ok(!(await ev(`window.__asked.some(s => /by=/.test(s))`)), 'and by= was not sent for it');
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
