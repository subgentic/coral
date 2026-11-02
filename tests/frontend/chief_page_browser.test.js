// The Chief page (/chief, #11450): the agent popout with nothing of Coral around it, for the Operator's phone: the chat, the composer and the cards an agent's asks make; no terminal switch, header actions, macro toolbar or
// tools pane. The server's gate (setting, recorded session) is Go's TestChiefPageServesOnlyTheRecordedAgentWhileTheSettingIsOn; this suite is the page's face at 390 px: the dashboard's pop-out mode with the page's marker
// (body data-chief="true"), against the fixture rows of agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('chief-a', 'A', 3, { sleeping: false, display_name: 'Chief' }); true`);
        await waitFor(`window._coralGetLiveSessions().some(r => r.session_id === 'chief-a-id')`, 'the agent row', 8000);
        await ev(`window.selectLiveSession('chief-a', 'claude', 'chief-a-id', 'local'); true`);
        await coralReady(ev, 'agentSelected', 'chief-a-id');
        const shown = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`;
        const before = {};
        for (const sel of ['.terminal-header', '#command-input', '.live-view-switch', '.command-pane-toolbar', '#agentic-state']) before[sel] = await ev(shown(sel));
        // the page's marker, as the server puts it on /chief
        await ev(`document.body.dataset.chief = 'true'; true`);
        check(await ev(shown('.terminal-header')) && await ev(shown('#command-input')), 'the header (the agent\'s name) and the composer stay');
        // QA's walk (#11499, finding 4): a display name the Operator gave is the header's name, not the job title or the team (the row has display_name Chief and the job title Orchestrator)
        await ev(`window._coralSetLiveSessions(window._coralGetLiveSessions().map(r => r.session_id === 'chief-a-id' ? { ...r, display_name: 'Chief', board_job_title: 'Orchestrator', board_project: 'chiefdesk' } : r)); true`);
        await waitFor(`document.getElementById('terminal-header-label') && document.getElementById('terminal-header-label').textContent.trim() === 'Chief'`, 'the header names the agent by its display name', 6000);
        for (const sel of ['.live-view-switch', '.command-pane-toolbar', '#agentic-state', '.terminal-header-actions', '.agent-bar-more', '.live-view-toggle']) check(!(await ev(shown(sel))), `${sel} is not on the Chief page`);
        check(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), 'no sideways scroll at 390 px');
        // Chief's avatar sits whole inside the header, at its top edge too (#11920): the page's own face, as showChiefFace draws it, at 390 light and dark
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'chief_look.js'); await m.showChiefFace(document.getElementById('terminal-header-label'), 'Chief'); return true; })()`).catch(() => {});
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'chief_look.js'); const label = document.getElementById('terminal-header-label'); if (!document.getElementById('chief-avatar-head')) { const a = m.avatarNode({ color: '3', letter: '', name: 'Chief', fronts: '' }, 'Chief'); a.id = 'chief-avatar-head'; label.before(a); } return true; })()`);
        for (const theme of ['light', 'dark']) {
            await ev(`document.body.classList.add('popout-mode'); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
            const g = await ev(`(() => { const a = document.getElementById('chief-avatar-head').getBoundingClientRect(), h = document.querySelector('.terminal-header').getBoundingClientRect(); const cs = e => getComputedStyle(e); const hh = document.querySelector('.terminal-header'); return { a: [a.top, a.bottom, a.height], h: [h.top, h.bottom, h.height], overflow: cs(hh).overflow }; })()`);
            console.log('   avatar geometry ' + theme + ': ' + JSON.stringify(g));
            check(g.a[0] - g.h[0] >= 4 && g.h[1] - g.a[1] >= 4 && Math.abs((g.a[0] + g.a[1]) / 2 - (g.h[0] + g.h[1]) / 2) <= 1, `Chief's avatar is centred in the header with room above and below at 390 ${theme} (it sat flush against the top edge): ${JSON.stringify(g)}`);
        }
        check(before['#command-input'] === true, 'the fixture shows the composer without the marker too (so hiding it would show)');
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the Chief page shows the chat and the composer and nothing else of Coral');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
