// The question an agent put on a file for review shows in Needs you (#11555's field review_question, shown here: v2.0.20): under the file's name on a wide row (the question first, then who uploaded it and their team: the uploader's
// name stays beside it, Security's condition), on a phone's second line in place of the words "For review", and in the viewer's line under the title. One line, text only, hidden characters written out (a U+202E shows
// <U+202E>, never raw); a file with no question says what it said before. Stubbed review rows, 1440 and 390. Drives Chrome through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, mobile] of [[1440, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/qn/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, name, q) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), produced_by: 'Writer', session_id: 's' + i, ...(q ? { review_question: q } : {}) });
                window.__items = [item(1, 'plan-a.md', 'Which port should the test server use?'), item(2, 'plan-b.md', 'Ship the second\\u202e design?'), item(3, 'plan-c.md', '')];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                    if (!/^\\/api\\/board\\/qn\\/artifacts$/.test(u.pathname)) return original(url, opts);
                    return json({ project: 'qn', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'three review rows', 15000);
            const rowText = n => ev(`(() => { const r = [...document.querySelectorAll('${T} tbody tr')].find(x => x.textContent.includes(${JSON.stringify(n)})); const sub = r.querySelector('.dt-subtitle'), meta = r.querySelector('.inbox-review-metadata'); return { all: r.textContent.replace(/\\s+/g, ' '), sub: sub ? sub.textContent : '', meta: meta ? meta.textContent : '', ask: (r.querySelector('.inbox-review-question') || {}).textContent || '', shown: [r.querySelector('.inbox-review-from'), sub].filter(x => x && getComputedStyle(x).display !== 'none').map(x => x.textContent).join(' | ') }; })()`);
            const a = await rowText('plan-a.md'), b = await rowText('plan-b.md'), c = await rowText('plan-c.md');
            if (mobile) {
                check(/Writer/.test(a.shown) && /Which port should the test server use\?/.test(a.shown) && !/For review/.test(a.shown), at + 'a phone row has the uploader on its top line and the question under it, not "For review": ' + JSON.stringify(a.shown));
                check(/For review/.test(c.shown) && !c.ask, at + 'a file with no question still says For review: ' + JSON.stringify(c.shown));
            } else {
                check(a.sub === 'Which port should the test server use?', at + 'the two lines under the name are the question (the uploader is on the top line, #11719): ' + JSON.stringify(a.sub));
                check(c.sub === 'For review', at + 'a file with no question says For review under the name: ' + JSON.stringify(c.sub));
            }
            check(/<U\+202E>/.test(b.all) && !b.all.includes('\u202e'), at + 'a hidden character in a question is written out, never drawn raw: ' + JSON.stringify(b.all.slice(0, 160)));

            // the viewer says it too
            await ev(`[...document.querySelectorAll('${T} tbody tr')].find(x => x.textContent.includes('plan-a.md')).querySelector('.inbox-review-name').click(); true`);
            await waitFor(`!!document.querySelector('.artifact-viewer-from') && !document.querySelector('.artifact-viewer-from').hidden`, at + 'the viewer opens with its from line', 8000);
            const from = await ev(`document.querySelector('.artifact-viewer-from').textContent`);
            check(/Which port should the test server use\?/.test(from) && /from Writer/.test(from), at + 'the viewer\'s line under the title has the question and the uploader: ' + JSON.stringify(from));
            await ev(`document.querySelector('.artifact-viewer-close')?.click(); true`);
            await removeBoards(ev, ['qn']).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_review_question_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
