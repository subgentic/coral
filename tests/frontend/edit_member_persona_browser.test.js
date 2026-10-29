// Edit member does not say "Start from a persona: Blank" over a member that has a role and a prompt (#10314, Beta #10305): the persona choice reads "Custom: this member's own role and prompt" for a member that
// is filled in, and stays "Blank: no persona" for a new one. New team > Members > Edit, 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady('startup', 'liveList', 'settings');
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'persona-x'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-team-next').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('team-agents-list')).display !== 'none' && document.querySelectorAll('#team-agents-list > *').length > 0`, 'the default members', 8000);
        const persona = () => ev(`(() => { const s = document.getElementById('launch-persona-select'); return s ? { text: s.options[s.selectedIndex].textContent.trim(), value: s.value } : null; })()`);
        await ev(`window.showTeamAgentModal(document.querySelector('#team-agents-list > *')); true`);
        await waitFor(`document.getElementById('launch-modal').getAttribute('data-member') === 'edit'`, 'Edit member', 6000);
        await settle(300);
        const edit = await persona();
        assert.match(edit.text, /^Custom: /, 'a member with a role and a prompt is custom, not Blank: ' + JSON.stringify(edit));
        assert.doesNotMatch(edit.text, /^Blank/);
        console.log('PASS Edit member says Custom over a filled-in member');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
