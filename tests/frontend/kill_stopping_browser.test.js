// Killing an agent says so at once (#15370, user feedback: "killing a session gives no feedback that it registered, and the row stays a few seconds"). Within 100 ms of the dialog's confirm the row says Stopping... (dimmed, busy,
// its actions off) even while the kill call takes seconds, it keeps saying so through a redraw of the list, and goes when the kill lands (within 1 s of the answer). A kill that fails takes the mark off and says why.
// The kill endpoint and the live list are answered in the page (held 1.5 s, then answered). Driven through the real menu and confirm dialog on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const S = (id, over) => ({ session_id: 'sid-' + id, name: 'agent-' + id, display_name: 'Agent ' + id, agent_type: 'claude', working_directory: '/repo/' + id, status: 'idle', ...over });
const SESSIONS = [S(1, { working_directory: '/repo/solo', display_name: 'Solo' }), S(2, { working_directory: '/repo/other', display_name: 'Other' })];

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
                window.__served = ${JSON.stringify(SESSIONS)}; window.__mode = 'slow';
                const real = window.fetch.bind(window);
                window.fetch = (u, o = {}) => {
                    const url = String(u), method = (o.method || 'GET').toUpperCase();
                    if (method === 'POST' && /\\/api\\/sessions\\/live\\/[^/]+\\/kill$/.test(url)) {
                        const sid = JSON.parse(o.body).session_id, ok = window.__mode === 'slow';
                        return new Promise(r => setTimeout(() => { if (ok) window.__served = window.__served.filter(s => s.session_id !== sid); r(new Response(JSON.stringify(ok ? { ok: true } : { error: 'the terminal would not end' }), { status: 200, headers: { 'content-type': 'application/json' } })); }, 1500));
                    }
                    if (method === 'GET' && /^\\/api\\/sessions\\/live(\\?|$)/.test(url)) return Promise.resolve(new Response(JSON.stringify(window.__served), { status: 200, headers: { 'content-type': 'application/json' } }));
                    return real(u, o);
                };
                state.settings = {}; state.liveSessions = JSON.parse(JSON.stringify(window.__served));
                render.flushLiveSessionsRender(); render.renderLiveSessions(state.liveSessions); return true; })()`);
            const row = id => `.session-group-item[data-session-id="${id}"]`;
            const stateOf = id => ev(`(() => { const r = document.querySelector('${row(id)}'); return r ? { cls: r.classList.contains('agent-stopping'), busy: r.getAttribute('aria-busy'), note: r.querySelector('.agent-stopping-note')?.textContent || '', pe: getComputedStyle(r).pointerEvents } : null; })()`);
            const kill = async id => { await ev(`document.querySelector('${row(id)} .sidebar-kebab-btn').click()`); await waitFor(`!!document.querySelector('${row(id)} [data-on-click="agent-kill"]')`, `${w}: the menu`); await ev(`document.querySelector('${row(id)} [data-on-click="agent-kill"]').click()`); await waitFor(`document.getElementById('confirm-modal').style.display === 'flex'`, `${w}: the confirmation (its module loads on first use, #15585)`, 5000); await ev(`document.getElementById('confirm-modal-yes').click(); performance.now()`); };

            console.log(`${w}: the row says Stopping... within 100 ms and keeps saying it through a redraw`);
            await kill('sid-1');
            await new Promise(r => setTimeout(r, 100)); // sleep-ok: the budget under test is 100 ms from the click
            assert.deepEqual(await stateOf('sid-1'), { cls: true, busy: 'true', note: 'Stopping…', pe: 'none' }, `${w}: Stopping... within 100 ms`);
            await ev(`import(${MOD} + 'render.js').then(async r => { const { state } = await import(${MOD} + 'state.js'); r.renderLiveSessions(state.liveSessions); return true; })`);
            await waitFor(`document.querySelector('${row('sid-1')} .agent-stopping-note')?.textContent === 'Stopping…'`, `${w}: the mark is back on the redrawn row`, 2000);
            assert.equal((await stateOf('sid-2')).cls, false, `${w}: the other agent is untouched`);
            const t0 = Date.now();
            await waitFor(`!document.querySelector('${row('sid-1')}')`, `${w}: the row goes when the kill lands`, 4000);
            assert.ok(Date.now() - t0 < 2500, `${w}: gone soon after the answer`);

            console.log(`${w}: a refused kill takes the mark off and says why`);
            await ev(`window.__mode = 'fail'; true`);
            await kill('sid-2');
            await new Promise(r => setTimeout(r, 100)); // sleep-ok: as above
            assert.equal((await stateOf('sid-2')).note, 'Stopping…', `${w}: Stopping... while it is asked`);
            await waitFor(`!document.querySelector('${row('sid-2')} .agent-stopping-note') && !document.querySelector('${row('sid-2')}').classList.contains('agent-stopping')`, `${w}: the mark comes off`, 4000);
            assert.ok(await ev(`/would not end/.test(document.body.innerText)`), `${w}: the reason is said`);
        }
        console.log('PASS kill_stopping_browser');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
