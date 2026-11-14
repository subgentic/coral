// ST2b: each moved setting has one home; old terminal links reach Defaults Advanced.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HOMES = {
    general: ['settings-theme', 'settings-group-by-team', 'settings-show-scrollbars', 'settings-terminal-font-size', 'settings-terminal-scrollback', 'settings-fit-pane-width', 'settings-renderer-select'],
    agents: ['settings-agent-type', 'settings-permission-mode', 'settings-working-dir', 'settings-auto-resume', 'settings-auto-sleep', 'settings-auto-sleep-minutes', 'settings-auto-goals', 'settings-agent-low-priority', 'settings-launch-in-worktree', 'tb-choice', 'tb-now'],
    chief: ['settings-board-auto-attach', 'settings-nudge-claude-artifacts', 'settings-board-health-monitor'],
    updates: ['settings-check-updates'],
};
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1440, 390]) for (const theme of ['dark', 'light']) for (const size of [16, 32]) {
        await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`document.documentElement.dataset.theme = '${theme}'; document.documentElement.style.fontSize = '${size}px'; window.showSettingsModal().then(() => true)`);
        const failures = await ev(`(() => { const homes = ${JSON.stringify(HOMES)}, errors = []; for (const [group, ids] of Object.entries(homes)) for (const id of ids) { const nodes = document.querySelectorAll('#' + id); if (nodes.length !== 1 || nodes[0].closest('.settings-pane')?.dataset.group !== group) errors.push(id + ': ' + nodes.length + ' copies, group ' + nodes[0]?.closest('.settings-pane')?.dataset.group); }
            if (document.getElementById('app-version-label')) errors.push('duplicate version remains');
            for (const id of ['settings-launch-in-worktree', 'tb-choice']) if (!document.getElementById(id)?.closest('details')) errors.push(id + ': missing Advanced fold');
            if (!document.querySelector('#settings-pane-general details #settings-renderer-select')) errors.push('drawing engine outside Appearance Advanced'); return errors; })()`);
        assert.deepEqual(failures, [], `${width}/${theme}/${size}: row homes`);
        for (const [group, ids] of Object.entries(HOMES)) {
            await ev(`window.showSettingsModal('${group}').then(() => true)`);
            await ev(`document.querySelectorAll('#settings-modal .settings-pane:not([hidden]) details').forEach(d => d.open = true); true`);
            const focus = ids.find(id => id !== 'tb-now');
            await waitFor(`document.getElementById('${focus}').getClientRects().length > 0`, 'moved control shown');
            assert.equal(await ev(`(() => { const e = document.getElementById('${focus}'); e.focus(); e.scrollIntoView({ block: 'nearest' }); return document.activeElement === e; })()`), true, `${group}: moved control can receive keyboard focus`);
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, `${width}/${theme}/${size}/${group}: no page overflow`);
        }
        await ev(`window.showSettingsModal('terminal').then(() => true)`);
        assert.equal(await ev(`!document.getElementById('settings-pane-agents').hidden && document.getElementById('settings-defaults-advanced').open`), true, 'legacy backend link opens its new home');
        }

        console.log('settings_row_homes_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
