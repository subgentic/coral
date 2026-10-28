// New project, step 3's side list (#10719, Desktop #10714 moment 5): "Start none", "Workflow none", "Health check off", "Messaging off" said their state and not what each is. Each tab now has a short plain tip as its tooltip, and
// for a screen reader as its description after the state; the visible words do not grow (the tab reads as before). At 1280 px (a phone picks the section from a select).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false]]) { // a phone picks the section from a select, not from this list
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.showLaunchModal(); true`); await waitFor(`document.querySelector('#launch-modal .modal-content') && document.querySelector('#launch-modal .modal-content').getClientRects().length > 0`, `${w}: the launch dialog`, 8000);
            await ev(`window._selectLaunchType('team'); true`); await waitFor(`document.getElementById('launch-step-team').dataset.stage === 'team'`, `${w}: step 1`, 8000);
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'tips-run'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/tmp/tips-run'; d.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('launch-team-next').click(); } true`);
            await waitFor(`document.getElementById('launch-step-team').dataset.stage === 'members'`, `${w}: step 2`, 8000);
            await ev(`document.getElementById('launch-team-next').click(); true`);
            await waitFor(`document.getElementById('launch-step-team').dataset.stage === 'start' && document.querySelectorAll('#team-start-host .settings-tab .menu-item-state').length >= 4`, `${w}: step 3 with its side list`, 10000);
            const tabs = await ev(`[...document.querySelectorAll('#team-start-host .settings-tab')].filter(t => t.getClientRects().length).map(t => ({ id: t.dataset.section, text: (() => { const n = t.querySelector('.settings-tab-name'), st = t.querySelector('.menu-item-state'); return (n.firstChild.textContent + ' ' + (st ? st.textContent : '')).trim(); })(), title: t.title, desc: (t.getAttribute('aria-describedby') || '').split(' ').map(i => (document.getElementById(i) || {}).textContent || '').join(' ').replace(/\\s+/g, ' ').trim() }))`);
            if (tabs.length < 4) { problems.push(`${w}: the side list has its four tabs (${tabs.length})`); continue; }
            for (const t of tabs) {
                if (!t.title || t.title.length < 15 || t.title.length > 110) problems.push(`${w}: "${t.text}" has a short tip as its tooltip (it is "${t.title}")`);
                if (!t.desc.includes(t.title) && t.title) problems.push(`${w}: "${t.text}": a screen reader hears the tip after the state (it hears "${t.desc}")`);
                if (t.title && t.text.includes(t.title)) problems.push(`${w}: "${t.text}": the tip is not visible words`);
            }
            const words = tabs.map(t => t.text).join(' | ');
            if (!/^Start \w+ \| Workflow \w+ \| Health check \w+ \| Messaging \w+$/.test(words)) problems.push(`${w}: the visible words are as before (${words})`);
            await ev(`window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'step 3 side list tips:\n  ' + problems.join('\n  '));
    console.log('PASS each tab of step 3 has a short tip, and no visible word grew');
})().catch(e => { console.error(e); process.exit(1); });
