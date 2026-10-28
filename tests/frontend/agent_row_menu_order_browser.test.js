// An agent row's menu and its Sleep dialog (#10785, Beta #10775: a first-time user, 13 items to read for Rename, Sleep and Archive; "Put "proj1" to sleep?" named the folder, not the agent, and said nothing of what stops):
// (1) Rename, Sleep and Archive come first; Restart (both), Set icon and Session info are under a More group (hidden until More is pressed, as the team menu's); (2) Auto-accept is drawn as a switch;
// (3) the Sleep dialog names the agent by its name, and says in one line what stops and what stays. At 1280 px; the page's mocked agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`);
        await waitFor(`!!document.querySelector('.session-group-item .sidebar-kebab-btn')`, 'the agent row', 10000);
        await ev(`document.querySelector('.session-group-item .sidebar-kebab-btn').click(); true`);
        await waitFor(`[...document.querySelectorAll('.sidebar-kebab-menu')].some(m => getComputedStyle(m).display !== 'none')`, 'the menu opens', 4000);
        const m = await ev(`(() => { const menu = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); const txt = e => e.textContent.replace(/\\s+/g, ' ').trim();
            const shown = [...menu.querySelectorAll('[role=menuitem], [role=menuitemcheckbox], .menu-item')].filter(e => !e.closest('[hidden]') && e.getClientRects().length).map(txt);
            const group = menu.querySelector('[role=group][hidden], .team-menu-more[hidden]'); const inGroup = group ? [...group.querySelectorAll('.menu-item')].map(txt) : null;
            const auto = menu.querySelector('.auto-accept-menu-item'); return { shown, inGroup, more: [...menu.querySelectorAll('.menu-item')].some(e => txt(e) === 'More'), switchDrawn: !!(auto && auto.querySelector('.menu-switch')) }; })()`);
        const at = w => m.shown.findIndex(x => x.startsWith(w));
        if (!(at('Rename') >= 0 && at('Rename') < at('Sleep') && at('Sleep') < at('Archive') && at('Archive') >= 0)) problems.push(`Rename, Sleep, Archive come in that order (the menu shows ${JSON.stringify(m.shown)})`);
        if (at('Rename') > 3 || at('Sleep') > 4 || at('Archive') > 5) problems.push(`they are among the first items (${JSON.stringify(m.shown)})`);
        for (const w of ['Restart, same settings', 'Restart with changes', 'Set Icon', 'Session Info']) if (at(w) >= 0) problems.push(`"${w}" is under More, not in the first list`);
        if (!m.more || !m.inGroup) problems.push('there is a More item with its group hidden under it');
        else for (const w of ['Restart, same settings', 'Restart with changes', 'Set Icon', 'Session Info']) if (!m.inGroup.some(x => x.startsWith(w))) problems.push(`"${w}" is in the More group (${JSON.stringify(m.inGroup)})`);
        if (!m.switchDrawn) problems.push('Auto-accept is drawn as a switch (.menu-switch), not a tick');
        await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        await ev(`window.toggleAgentSleep('proj1', 'claude', 'w-sid', 'sleep'); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the Sleep dialog', 4000);
        const d = await ev(`document.getElementById('confirm-modal-message').textContent.replace(/\\s+/g, ' ').trim()`);
        if (!/Writer/.test(d)) problems.push(`the Sleep dialog names the agent (Writer), not the folder: "${d}"`);
        if (!/stops/i.test(d) || !/stay/i.test(d)) problems.push(`the Sleep dialog says what stops and what stays: "${d}"`);
        if (d.split(/\s+/).length > 40) problems.push(`and in a line, not a paragraph (${d.split(/\s+/).length} words)`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the agent row menu and Sleep dialog:\n  ' + problems.join('\n  '));
    console.log('PASS the row menu leads with Rename, Sleep and Archive; Sleep names the agent');
})().catch(e => { console.error(e); process.exit(1); });
