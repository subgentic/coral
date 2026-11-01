// Files for review that were never answered are said on the goal (#11885, Beta #11837 D and G): the Close goal dialog warns "7 files for review on this goal are still waiting for you. They stay in Needs you after the goal is
// closed." (a goal with none shows no such warning), and the goal's page says "3 files for this goal are waiting for your review." with Review them, which opens Needs you narrowed to that goal. A real team and goals; the
// team's files are a page stub (three for this goal, one for another goal, one for none). 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'grw-' + Date.now().toString(36), B2 = B + '-other', S = `(window.__coralStatic || '/static/')`;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: B })).status, 200);
        const mk = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201); assert.equal((await api('PATCH', `/api/board/${B}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200); return g.body.id; };
        assert.equal((await api('POST', `/api/board/${B2}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: B2 })).status, 200); // another team: a goal page reads its own team's files, not every team's (#11913)
        const G1 = await mk('Sprout app'), G2 = await mk('Other goal'), G3 = await mk('A goal with no files');
        const stub = `(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })), hex = n => n.toString(16).padStart(64, '0');
            const f = (i, goal, title) => ({ id: hex(i), name: 'file-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - i * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Writer', goal_id: goal, goal_title: title, uri: 'coral://artifacts/' + hex(i) });
            const items = [f(1, ${G1}, 'Sprout app'), f(2, ${G1}, 'Sprout app'), f(3, ${G1}, 'Sprout app'), f(4, ${G2}, 'Other goal'), f(5, 0, '')];
            window.__art = window.__art || []; window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin); const am = /^\\/api\\/board\\/([^/]+)\\/artifacts$/.exec(u.pathname); if (am && (opts.method || 'GET') === 'GET') window.__art.push(am[1]); if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${B}/artifacts') return json({ project: '${B}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); return original(url, opts); }; return true; })()`;
        await Page.addScriptToEvaluateOnNewDocument({ source: stub }); // before the page reads its files, as the real server answers from the first read
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await load(`/team/${B}/goals/${G1}`);
            await waitFor(`!!document.querySelector('#goals-detail-title') && !!document.querySelector('.goal-reviews-waiting:not([hidden])')`, at + 'the goal page says files wait', 15000).catch(async () => { throw new Error(at + 'the line was not drawn: ' + await ev(`(document.querySelector('.goal-reviews-waiting') || {}).outerHTML`)); });
            const line = await ev(`document.querySelector('.goal-reviews-waiting').textContent.replace(/\\s+/g, ' ').trim()`);
            assert.equal(line, '3 files for this goal are waiting for your review. Review them', at + 'the goal page line: ' + line);
            const reads = await ev(`window.__art`);
            assert.ok(reads.length >= 1 && reads.every(t => t === B), at + 'only this goal\'s team was read, not every team: ' + JSON.stringify(reads));
            await shot(`goal-reviews-waiting-${w}`);
            // the Close goal dialog warns, with the same count
            await ev(`document.querySelector('.goals-close').click(); true`);
            await waitFor(`!!document.querySelector('.goals-close-dialog[open] .goals-reviews-warning')`, at + 'the Close dialog warns', 8000);
            const warn = await ev(`document.querySelector('.goals-reviews-warning').textContent.replace(/\\s+/g, ' ').trim()`);
            assert.equal(warn, '3 files for review on this goal are still waiting for you. They stay in Needs you after the goal is closed.', at + 'the warning: ' + warn);
            await shot(`goal-reviews-close-${w}`);
            await ev(`[...document.querySelectorAll('.goals-close-dialog[open] button')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
            // Review them: Needs you, narrowed to this goal
            await ev(`import(${S} + 'needs_filters.js').then(m => { m.saveFilters({ ...m.EMPTY, kind: 'review', sort: 'oldest' }); return true; })`);
            const savedBefore = await ev(`localStorage.getItem('coral-inbox-needs-filters')`);
            await ev(`document.querySelector('.goal-reviews-link').click(); true`);
            await waitFor(`document.body.dataset.navTab === 'hub-inbox' && document.querySelectorAll('#group-table-view tbody tr').length === 3`, at + 'Needs you shows this goal\'s three files', 15000);
            assert.ok(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].every(r => /file-[123]\\.md/.test(r.textContent))`), at + 'and only those');
            assert.equal(await ev(`localStorage.getItem('coral-inbox-needs-filters')`), savedBefore, at + 'Review them did not overwrite the person\'s saved Needs you filters: ' + savedBefore);
            // a goal with no files waiting: no warning, no line
            await load(`/team/${B}/goals/${G3}`);
            await waitFor(`!!document.querySelector('#goals-detail-title')`, at + 'the other goal page', 15000);
            await ev(framesJs(10));
            assert.equal(await ev(`!!document.querySelector('.goal-reviews-waiting:not([hidden])')`), false, at + 'a goal with no files waiting says nothing');
            await ev(`document.querySelector('.goals-close').click(); true`);
            await waitFor(`!!document.querySelector('.goals-close-dialog[open]')`, at + 'its Close dialog', 8000); await ev(framesJs(10));
            assert.equal(await ev(`!!document.querySelector('.goals-reviews-warning')`), false, at + 'and its Close dialog has no warning');
            await ev(`[...document.querySelectorAll('.goals-close-dialog[open] button')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
        }
        console.log('goal_review_waiting_browser: ok');
    } finally { await removeBoards(ev, [B, B2]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
