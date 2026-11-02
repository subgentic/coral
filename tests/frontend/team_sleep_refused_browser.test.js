// Sleep Team that the server refuses must say so (#12417, Beta Tester: "Sleep Team did nothing on 3 mock agents: confirmed in the dialog, the menu still said Sleep Team, the rows stayed idle, no Wake button"). The route
// answers 200 with {ok: false, error} when it did nothing (no sessions on that board), and toggleTeamSleep read only `sleeping` from the answer: a refusal became "Team is awake", the rows were set awake and nothing
// said why. A refusal now shows its words, as an error, and changes no row; an answer that did sleep the team still says so.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const run = async (answer, status) => {
            await ev(`(() => { window.__sleepAnswer = ${JSON.stringify(answer)}; window.__sleepStatus = ${status}; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (/\\/api\\/sessions\\/live\\/team\\/[^/]+\\/sleep$/.test(url.pathname)) return Promise.resolve(new Response(JSON.stringify(window.__sleepAnswer), { status: window.__sleepStatus, headers: { 'content-type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
            await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); s.state.liveSessions = [{ session_id: 'a1', name: 'claude-a1', agent_type: 'claude', board_project: 'b-x', sleeping: false, archived: false }]; window.toggleTeamSleep('b-x', 'sleep'); return true; })()`);
            await waitFor(`!!document.getElementById('confirm-modal-yes') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the Sleep team question', { timeout: 8000 });
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`document.querySelectorAll('.toast').length > 0`, 'a toast says what happened', { timeout: 8000 });
            return ev(`({ toasts: [...document.querySelectorAll('.toast')].map(t => ({ text: t.textContent.trim(), error: t.classList.contains('toast-error') || /error|danger/.test(t.className) })) })`);
        };
        const rows = () => ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => m.state.liveSessions.map(s => s.sleeping))`);
        const refused = await run({ ok: false, error: 'No sessions found on that board' }, 200);
        assert.ok(refused.toasts.some(t => /No sessions found on that board/.test(t.text)), 'the refusal is said in its own words: ' + JSON.stringify(refused.toasts));
        assert.ok(!refused.toasts.some(t => /is awake|is now sleeping/.test(t.text)), 'and is not reported as the team being awake or asleep: ' + JSON.stringify(refused.toasts));
        assert.deepEqual(await rows(), [false], 'no row changed');
        const denied = await run({ error: 'Coral is locked' }, 403);
        assert.ok(denied.toasts.some(t => /locked|Could not/.test(t.text)) && !denied.toasts.some(t => /is awake|is now sleeping/.test(t.text)), 'a 403 is said too: ' + JSON.stringify(denied.toasts));
        const done = await run({ ok: true, sleeping: true, sessions_affected: 1 }, 200);
        assert.ok(done.toasts.some(t => /is now sleeping/.test(t.text)), 'an answer that slept the team still says so: ' + JSON.stringify(done.toasts));
        assert.deepEqual(await rows(), [true], 'and the rows sleep');
    } finally { await client.close(); }
    console.log('team_sleep_refused_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
