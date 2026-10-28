// Words the Mobile tester's pass 28 found (#10558, part 2): the Share Team dialog says what sharing does (it had no text but its buttons). Isolated dev server, 390 px, a stubbed agent on a team.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { window.__m.agents = {}; window.__m.add('x', 'A', 3, { sleeping: false, session_id: 'sx' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), board_project: 'team-x' }))); return true; })()`);
        await ev(`window.shareAgentTeam('team-x'); true`);
        await waitFor(`!!document.querySelector('.modal .form-textarea-readonly')`, 'the Share Team dialog', 8000);
        const said = await ev(`document.querySelector('.modal .form-textarea-readonly').closest('.modal-content').querySelector('.modal-header').textContent.replace(/\\s+/g, ' ').trim()`);
        assert.match(said, /Export Team: .*1 agent\. This file starts the same team on any Coral: in New team, choose Import a template\. Copy it or download it\./, 'the dialog says what the file does: ' + said);
        await ev(`window.hideLaunchModal && window.hideLaunchModal(); document.querySelectorAll('.modal').forEach(m => { if (m.id !== 'launch-modal') m.remove(); }); true`);
        // New team step 3 (Mobile tester: the header's second line "Step 3 of 3: Start and team settings. demo in /tmp/..." ran past the edge at a narrow width): the line wraps inside the dialog at 320 and 390 px
        for (const w of [390, 320]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 700, deviceScaleFactor: 2, mobile: true });
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
            await ev(`(async () => { document.getElementById('team-board-name').value = 'a-team-with-a-rather-long-name'; const d = document.getElementById('team-dir'); if (d) d.value = '/Users/someone/work/a-very-long-folder-name/for-the-new-team'; const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('start'); return true; })()`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the step draws
            const head = await ev(`(() => { const sub = document.getElementById('team-stage-sub'), box = document.querySelector('#launch-modal .modal-content').getBoundingClientRect(), r = sub.getBoundingClientRect(); return { text: sub.textContent.trim().slice(0, 90), left: Math.round(r.left), right: Math.round(r.right), boxLeft: Math.round(box.left), boxRight: Math.round(box.right), over: sub.scrollWidth - sub.clientWidth }; })()`);
            assert.ok(head.left >= head.boxLeft - 1 && head.right <= head.boxRight + 1 && head.over <= 1, `${w}: the step line is whole inside the dialog: ` + JSON.stringify(head));
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('PASS the Share Team dialog says what it does, and the step line is whole');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
