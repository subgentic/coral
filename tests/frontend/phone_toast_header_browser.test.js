// A short toast on a phone does not cover the open agent's header (Mobile tester's first pass, #9985): the toast column started below the top bar and sat over the header's state, name and Chat/Terminal toggle for its three seconds.
// At 390 and 360 px with an agent open, a success toast and an error toast start below the header and clear of the toggle; with no agent open they stay below the top bar as before. Drives Chrome over CDP through
// agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const base = { session_id: 'o1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'feat/x', repo_name: 'coral', working_directory: '/work/p', status: 'idle', server: 'local' };
    const rects = () => ev(`(() => { const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; }; return { toast: r(document.querySelector('#toast-host > .toast')), header: r(document.querySelector('#live-session-view .terminal-header')), toggle: r(document.querySelector('#live-session-view .live-view-toggle')), bar: r(document.querySelector('header.top-bar')) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [390, 360]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            const toast = async (msg, isError) => { await ev(`import((window.__coralStatic || '/static/') + 'utils.js').then(m => { m.showToast(${JSON.stringify(msg)}, ${isError}); return true; })`); await waitFor(`!!document.querySelector('#toast-host > .toast')`, `${w}: the toast`, 5000); await new Promise(r => setTimeout(r, 450)); }; // sleep-ok: the toast slides in
            // no agent open: below the top bar, as before
            await toast('Copied to the clipboard', false);
            let m = await rects();
            if (!m.toast || m.toast.top < m.bar.bottom) problems.push(`${w}: with no agent open the toast is below the top bar: ${JSON.stringify(m)}`);
            // and below the list's own title (Live Sessions), which it covered (#10052)
            const title = await ev(`(() => { const e = document.querySelector('.mobile-list-title'); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; })()`);
            if (!title) problems.push(`${w}: the phone list's title is on screen with no agent open`);
            else if (m.toast.top < title.bottom) problems.push(`${w}: the toast starts below the list title: ${JSON.stringify([m.toast, title])}`);
            await ev(`document.querySelectorAll('#toast-host > .toast').forEach(t => t.remove()); true`);
            // an agent open: below its header
            await ev(`T.state.liveSessions = ${JSON.stringify([base])}; T.render.renderLiveSessions(T.state.liveSessions); window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
            await waitFor(`!!document.querySelector('#live-session-view .terminal-header') && document.querySelector('#live-session-view .terminal-header').getClientRects().length > 0`, `${w}: the agent header`, 10000);
            for (const [msg, isError] of [['Copied to the clipboard', false], ['Could not copy', true]]) {
                await toast(msg, isError);
                m = await rects();
                if (!m.toast || !m.header || m.toast.top < m.header.bottom) problems.push(`${w}: the ${isError ? 'error' : 'success'} toast starts below the agent header: ${JSON.stringify(m)}`);
                await ev(`document.querySelectorAll('#toast-host > .toast').forEach(t => t.remove()); true`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the toast and the agent header on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS toasts on a phone stay clear of the agent header');
})().catch(e => { console.error(e); process.exit(1); });
