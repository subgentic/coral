// Killing a whole team or all agents of a group marks EVERY row Stopping... at once (#15431, the follow-up to #15370: only a single kill showed it). Kill Team makes one call that answers after seconds; a group's Kill All
// kills one agent after another, so the later rows used to look untouched until their turn. Both are driven through the real functions and the real confirm dialog on the isolated dev server; the endpoints are
// answered in the page. A refused team kill takes every mark off and says why.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const S = (id, over) => ({ session_id: 'sid-' + id, name: 'agent-' + id, display_name: 'Agent ' + id, agent_type: 'claude', working_directory: '/repo/' + id, status: 'idle', ...over });
const TEAM = [1, 2, 3].map(i => S('t' + i, { board_project: 'crew' }));
const FLOW = [1, 2, 3].map(i => S('f' + i, { workflow_name: 'flow' }));
const OTHER = S('o1', { working_directory: '/repo/other' });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => {
                const render = await import(${MOD} + 'render.js'); const { state } = await import(${MOD} + 'state.js');
                window.__served = ${JSON.stringify([...TEAM, ...FLOW, OTHER])}; window.__mode = 'slow';
                const real = window.fetch.bind(window);
                const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
                window.fetch = (u, o = {}) => {
                    const url = String(u), method = (o.method || 'GET').toUpperCase();
                    if (method === 'POST' && /\\/api\\/sessions\\/live\\/team\\/[^/]+\\/kill$/.test(url)) {
                        const ok = window.__mode === 'slow';
                        return new Promise(r => setTimeout(() => { if (ok) window.__served = window.__served.filter(s => s.board_project !== 'crew'); r(json(ok ? { ok: true, sessions_killed: 3 } : { error: 'the team would not stop' }, ok ? 200 : 500)); }, 1500));
                    }
                    if (method === 'POST' && /\\/api\\/sessions\\/live\\/[^/]+\\/kill$/.test(url)) {
                        const sid = JSON.parse(o.body).session_id;
                        return new Promise(r => setTimeout(() => { window.__served = window.__served.filter(s => s.session_id !== sid); r(json({ ok: true })); }, 600));
                    }
                    if (method === 'GET' && /^\\/api\\/sessions\\/live(\\?|$)/.test(url)) return Promise.resolve(json(window.__served));
                    return real(u, o);
                };
                state.settings = {}; state.liveSessions = JSON.parse(JSON.stringify(window.__served));
                render.flushLiveSessionsRender(); render.renderLiveSessions(state.liveSessions); return true; })()`);
            const marked = ids => ev(`(${JSON.stringify(ids)}).map(id => [...document.querySelectorAll('[data-session-id="' + id + '"]')].some(r => r.classList.contains('agent-stopping') && r.querySelector('.agent-stopping-note')?.textContent === 'Stopping…'))`);
            const confirm = fn => ev(`import(${MOD} + 'team_actions.js').then(m => { m.${fn}; return true; })`).then(() => waitFor(`!!document.getElementById('confirm-modal-yes')`, `${w}: the confirm`)).then(() => ev(`document.getElementById('confirm-modal-yes').click(); true`));
            const ids = list => list.map(s => s.session_id);

            console.log(`${w}: Kill Team marks every member at once, and the others stay unmarked`);
            await confirm(`killBoard('crew')`);
            await new Promise(r => setTimeout(r, 150)); // sleep-ok: the budget under test is a moment from the click, the call takes 1.5 s
            assert.deepEqual(await marked(ids(TEAM)), [true, true, true], `${w}: all three members say Stopping...`);
            assert.deepEqual(await marked([OTHER.session_id, ...ids(FLOW)]), [false, false, false, false], `${w}: nobody else`);
            await waitFor(`!document.querySelector('[data-session-id="sid-t1"]')`, `${w}: the rows go when the team stops`, 5000);

            console.log(`${w}: a refused Kill Team takes every mark off and says why`);
            await ev(`window.__served = ${JSON.stringify([...TEAM, ...FLOW, OTHER])}; window.__mode = 'fail'; import(${MOD} + 'state.js').then(async ({ state }) => { state.liveSessions = JSON.parse(JSON.stringify(window.__served)); (await import(${MOD} + 'render.js')).renderLiveSessions(state.liveSessions); return true; })`);
            await confirm(`killBoard('crew')`);
            await new Promise(r => setTimeout(r, 150)); // sleep-ok: as above
            assert.deepEqual(await marked(ids(TEAM)), [true, true, true], `${w}: marked while asked`);
            await waitFor(`${JSON.stringify(ids(TEAM))}.every(id => [...document.querySelectorAll('[data-session-id="' + id + '"]')].every(r => !r.classList.contains('agent-stopping')))`, `${w}: every mark comes off`, 5000);
            assert.ok(await ev(`/would not stop/.test(document.body.innerText)`), `${w}: the reason is said`);

            console.log(`${w}: Kill All of a group marks every agent from the click, not one at a time`);
            await ev(`window.__mode = 'slow'; true`);
            await confirm(`killGroup('wf:flow')`);
            await new Promise(r => setTimeout(r, 150)); // sleep-ok: as above; the agents are killed one after another (600 ms each)
            assert.deepEqual(await marked(ids(FLOW)), [true, true, true], `${w}: the last agent says Stopping... while the first is still being killed`);
            assert.deepEqual(await marked([OTHER.session_id]), [false], `${w}: an agent outside the group is untouched`);
            await waitFor(`!document.querySelector('[data-session-id="sid-f3"]')`, `${w}: the rows go as they are killed`, 6000);
        }
        console.log('PASS kill_team_stopping_browser');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
