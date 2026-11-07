// Wake Team and the agents Kill All ended (#14208, the live reproduction): the route answers ok false naming them with an `ended` list; the dashboard says so in a toast and asks once to resume them all;
// Cancel starts nothing; Confirm resumes each in its own folder on the team's board (the History Resume's two calls) and says who is back. A member that did not start is named, never marked awake.
// A team woken with a failed start says "only partly awake". Drives Chrome over CDP through agent_view_harness.js against the isolated dev server; only the wake, resume-info and launch calls are answered by the test.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => {
            window.__calls = []; window.__wake = null;
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = (o.method || 'GET').toUpperCase();
                if (/\\/api\\/sessions\\/live\\/team\\/[^/]+\\/wake$/.test(p.pathname) && m === 'POST') { window.__calls.push({ m, path: p.pathname }); return json(window.__wake); }
                if (/\\/api\\/sessions\\/history\\/[^/]+\\/resume-info$/.test(p.pathname)) { const sid = decodeURIComponent(p.pathname.split('/history/')[1].split('/')[0]);
                    window.__calls.push({ m, path: p.pathname });
                    if (sid === 'sid-dev') return json({ working_dir: '/work/gone', working_dir_exists: false, agent_type: 'claude' });
                    return json({ working_dir: '/work/crew', working_dir_exists: true, agent_type: 'claude', display_name: sid === 'sid-lead' ? 'Lead' : 'QA', permission_mode: 'default', resume_session_id: sid }); }
                if (p.pathname === '/api/sessions/launch' && m === 'POST') { window.__calls.push({ m, path: p.pathname, body: JSON.parse(o.body) }); return json({ ok: true, session_id: 'new-' + window.__calls.length }); }
                return real(u, o); };
            return true; })()`);
        const toasts = () => ev(`[...document.querySelectorAll('.toast .toast-message')].map(t => t.textContent)`);
        const confirmOpen = () => ev(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`);
        const confirmText = () => ev(`({ title: document.getElementById('confirm-modal-title').textContent, message: document.getElementById('confirm-modal-message').textContent, yes: document.getElementById('confirm-modal-yes').textContent })`);
        const launches = () => ev(`window.__calls.filter(c => c.path === '/api/sessions/launch').map(c => c.body)`);

        console.log('Wake Team found members Kill All ended: the toast says so and one question offers to resume them');
        await ev(`window.__wake = { ok: false, sleeping: false, sessions_relaunched: 0, failed: null, error: 'Lead, Dev and QA were ended, not asleep, so Wake does not apply. Resume them to bring the team back.',
            ended: [{ session_id: 'sid-lead', agent_type: 'claude', name: 'Lead' }, { session_id: 'sid-dev', agent_type: 'claude', name: 'Dev' }, { session_id: 'sid-qa', agent_type: 'claude', name: 'QA' }] }; window.toggleTeamSleep('b-crew', 'wake'); true`);
        await waitFor(`!!document.querySelector('.toast .toast-message') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the toast and the question');
        assert.deepEqual(await toasts(), ['Lead, Dev and QA were ended, not asleep, so Wake does not apply. Resume them to bring the team back.'], 'the dashboard does not say the team is awake');
        const q = await confirmText();
        assert.equal(q.title, 'Resume agents'); assert.equal(q.yes, 'Resume agents');
        assert.match(q.message, /^Lead, Dev and QA were ended in "b-crew".* Resume them\? Each starts again in its own folder with its earlier chat/);
        assert.deepEqual(await launches(), [], 'nothing is started before the answer');

        console.log('Cancel starts nothing');
        await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
        assert.deepEqual(await launches(), []);
        assert.equal(await confirmOpen(), false);

        console.log('Confirm resumes each in turn on the team\'s board; the member whose folder is gone is named and the rest still start');
        await ev(`window.__calls.length = 0; document.querySelectorAll('.toast').forEach(t => t.remove()); window.toggleTeamSleep('b-crew', 'wake'); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question again');
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__calls.filter(c => c.path === '/api/sessions/launch').length === 2 && [...document.querySelectorAll('.toast .toast-message')].some(t => /did not start/.test(t.textContent))`, 'the two starts and the result');
        const sent = await launches();
        assert.deepEqual(sent.map(b => [b.display_name, b.resume_session_id, b.board_id, b.board_name, b.working_dir]), [['Lead', 'sid-lead', 'b-crew', 'b-crew', '/work/crew'], ['QA', 'sid-qa', 'b-crew', 'b-crew', '/work/crew']], 'Lead and QA, in order, in their folder, on the team board; Dev has no folder and starts nothing');
        const last = (await toasts()).filter(t => /did not start/.test(t));
        assert.match(last[0], /^Lead and QA are back in "b-crew"\. Dev did not start: Dev is not running, and the folder it worked in is gone \(\/work\/gone\)/);

        console.log('A wake where a start failed says only partly awake and does not mark that member awake');
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__wake = { ok: true, sleeping: false, sessions_relaunched: 1, ended: [], failed: [{ name: 'Dev', session_id: 'sid-dev', error: 'pty spawn failed: no such cli' }] }; window.toggleTeamSleep('b-crew', 'wake'); true`);
        await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(t => /only partly awake/.test(t.textContent))`, 'the partly awake toast');
        assert.deepEqual(await toasts(), ['Team "b-crew" is only partly awake. Dev did not start: pty spawn failed: no such cli.']);
        assert.equal(await confirmOpen(), false, 'nothing ended: no question');

        console.log('PASS wake team ended');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
