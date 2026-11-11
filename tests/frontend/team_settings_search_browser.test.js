// Team settings: grouping and search (#15058). Large headings group several concepts, a setting that hangs on a toggle sits under it (indented, dimmed when the toggle is off), and a search box
// over every section finds a setting by its label or help, names its section, says 'No settings match' when empty, clears on Esc and opens the first match's section on Enter.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const TEAM = 'search-team';
    const S = `(window.__coralStatic || '/static/')`;
    const root = `document.getElementById('team-settings-workspace')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        assert.ok(sub < 300);
        await ev(`import(${S} + 'team_settings_page.js').then(m => m.showTeamSettingsPage(${JSON.stringify(TEAM)}, { page: (document.getElementById('pin-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pin-host' }))) })); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the Team settings', 15000);

        console.log('1. Large headings group several concepts, in Workflow and Health check');
        const bigs = sec => ev(`[...${root}.querySelectorAll('.settings-pane[data-section=${sec}] .tsg-big-h')].map(h => h.textContent)`);
        const wf = await bigs('workflow'), hc = await bigs('health');
        assert.ok(wf.length >= 3, 'Workflow has large headings: ' + wf);
        assert.ok(hc.length >= 4, 'Health check has large headings: ' + hc);
        assert.ok(hc.includes('Watching the agents') && hc.includes('Watching the work'), 'named groups: ' + hc);
        await ev(`${root}.querySelector('.settings-tab[data-section=health]').click(); true`);
        const sz = await ev(`(() => { const b = ${root}.querySelector('.settings-pane[data-section=health] .tsg-big-h'), s = ${root}.querySelector('.settings-pane[data-section=health] .sv-heading:not(.tsg-big-h)'); return { big: parseFloat(getComputedStyle(b).fontSize), sub: parseFloat(getComputedStyle(s).fontSize) }; })()`);
        assert.ok(sz.big > sz.sub, 'a large heading is larger than a sub-heading: ' + JSON.stringify(sz));

        console.log('2. A dependent setting sits under its toggle and dims when the toggle is off');
        const dep = await ev(`(() => { const r = ${root}.querySelector('.sv-row[data-key=interval_min]'); const t = ${root}.querySelector('.sv-row[data-key=on]'); return { cls: r.classList.contains('tsg-dep'), indent: r.getBoundingClientRect().left - t.getBoundingClientRect().left, rail: getComputedStyle(r).borderLeftWidth }; })()`);
        assert.ok(dep.cls && dep.indent >= 10 && dep.rail !== '0px', 'interval_min hangs on the health toggle: ' + JSON.stringify(dep));
        const offState = await ev(`(() => { const on = ${root}.querySelector('input[name=on]') || ${root}.querySelector('.sv-row[data-key=on] input'); const r = ${root}.querySelector('.sv-row[data-key=interval_min]'); if (on.checked) on.click(); return { dis: r.hasAttribute('data-disabled'), op: getComputedStyle(r).opacity }; })()`);
        assert.ok(offState.dis && parseFloat(offState.op) < 1, 'dimmed with the toggle off: ' + JSON.stringify(offState));

        console.log('3. Search: labelled, finds across sections, names the section, highlights the row');
        const box = await ev(`(() => { const i = ${root}.querySelector('.tsg-search-input'); return i ? { label: i.getAttribute('aria-label'), type: i.type } : null; })()`);
        assert.ok(box && box.label && box.type === 'search', 'a labelled search box: ' + JSON.stringify(box));
        const type = async text => { await ev(`(() => { const i = ${root}.querySelector('.tsg-search-input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); };
        await type('messages');
        const res = await ev(`(() => ({ searching: !!${root}.querySelector('.tsg-searching') || ${root}.classList.contains('tsg-searching') || !!${root}.closest('.tsg-searching'), matches: ${root}.querySelectorAll('.sv-row[data-match]').length, shown: [...${root}.querySelectorAll('.sv-row[data-match]')].filter(r => r.getClientRects().length).length, panes: [...${root}.querySelectorAll('.settings-pane[data-hit]')].filter(p => p.getClientRects().length).map(p => p.dataset.section), status: ${root}.querySelector('.tsg-search-status').textContent }))()`);
        assert.ok(res.searching && res.matches > 0 && res.shown === res.matches, 'matching rows are shown: ' + JSON.stringify(res));
        assert.ok(res.panes.length >= 1 && /match/.test(res.status), 'sections named, count said: ' + JSON.stringify(res));

        console.log('4. No result says so, Esc clears and brings the sections back');
        await type('zzzqqq');
        const none = await ev(`({ text: ${root}.querySelector('.tsg-search-status').textContent, hidden: ${root}.querySelector('.tsg-search-status').hidden, role: ${root}.querySelector('.tsg-search-status').getAttribute('role') })`);
        assert.ok(!none.hidden && /No settings match/.test(none.text) && none.role === 'status', JSON.stringify(none));
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        const cleared = await ev(`({ v: ${root}.querySelector('.tsg-search-input').value, searching: !!document.querySelector('.tsg-searching'), marks: ${root}.querySelectorAll('[data-match],[data-nomatch]').length, open: [...${root}.querySelectorAll('.settings-pane')].filter(p => p.getClientRects().length).length })`);
        assert.equal(cleared.v, ''); assert.ok(!cleared.searching && cleared.marks === 0 && cleared.open === 1, 'cleared: ' + JSON.stringify(cleared));

        console.log('5. Enter opens the first match\'s section');
        await ev(`${root}.querySelector('.settings-tab[data-section=workflow]').click(); true`);
        await type('Landing alert');
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        const jumped = await ev(`({ sec: ${root}.querySelector('.settings-pane:not([hidden])').dataset.section, hit: !!${root}.querySelector('.sv-row[data-key=landing_on][data-match]'), v: ${root}.querySelector('.tsg-search-input').value })`);
        assert.ok(jumped.sec === 'health' && jumped.hit && jumped.v === '', 'Enter jumps to the section and marks the row: ' + JSON.stringify(jumped));
        const said = await ev(`({ status: ${root}.querySelector('.tsg-search-status').textContent, inRow: !!document.activeElement.closest('.sv-row[data-key=landing_on]'), live: ${root}.querySelector('.tsg-search-status').getAttribute('role') })`);
        assert.ok(/^Opened Health check: Landing alert$/.test(said.status) && said.inRow && said.live === 'status', 'Enter moves the focus to the row\'s control and the status says where: ' + JSON.stringify(said));

        console.log('6. A stylesheet that cannot load leaves the settings showing, ungrouped');
        await client.Network.enable(); await client.Network.setBlockedURLs({ urls: ['*team_settings_groups.css*'] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`import(${S} + 'team_settings_page.js').then(m => m.showTeamSettingsPage(${JSON.stringify(TEAM)}, { page: (document.getElementById('pin-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pin-host' }))) })); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the Team settings with the groups stylesheet blocked', 15000);
        const bare = await ev(`({ rows: ${root}.querySelectorAll('.sv-row[data-key]').length, bigs: ${root}.querySelectorAll('.tsg-big-h').length, search: !!${root}.querySelector('.tsg-search-input') })`);
        assert.ok(bare.rows > 10 && bare.bigs > 0 && bare.search, 'the settings still show, with their groups and search, when the sheet is blocked: ' + JSON.stringify(bare));
        await client.Network.setBlockedURLs({ urls: [] });
        console.log('PASS team settings grouping and search');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
