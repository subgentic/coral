// #16873: two teams have the same agent name; row identity leads with team, and filters close on Clear/navigation.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'settings');
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`);
            await ev(`(async () => { window.__m.agents = {}; window.__m.add('perm-bot', 'A', 1, { sleeping: false, board_project: 'alpha-team' }); window.__m.add('ask-bot', 'B', 1, { sleeping: false, board_project: 'beta-team' }); const ws = await import(${S} + 'websocket.js'); const { state } = await import(${S} + 'state.js'); if (state.coralWs) { state.coralWs.onclose = null; state.coralWs.onmessage = null; try { state.coralWs.close(); } catch {} }
                const sessions = Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), display_name: 'Orchestrator', waiting_for_input: true, waiting_kind: /perm/.test(a.name) ? 'permission' : 'question', waiting_summary: /perm/.test(a.name) ? 'Wants to use Bash' : 'Wants to know: Pick a color', waiting_since: new Date(Date.now() - 60000).toISOString() }));
                ws.handleCoralMessage({ type: 'coral_update', servers: [], sessions }); return true; })()`);
            const openNeeds = async () => { await ev(`window.switchNavTab('hub-inbox'); true`); await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await waitFor(`document.getElementById('group-table-view') && document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view tbody tr:not(.dt-group), #group-table-view .dt-mail-row, #group-table-view [data-row-key]').length >= 2`, `${w}: the two waiting agents`, 10000); };
            await openNeeds();
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].map(r=>r.innerText.replace(/\\s+/g,' ').trim())`);
            for (const team of ['alpha-team','beta-team']) assert.ok(rows.some(t=>t.startsWith(team+' · Orchestrator')), `${w}: team leads row identity: ${JSON.stringify(rows)}`);
            const toggle = '#inbox-needs-toggle';
            assert.ok((await ev(`document.querySelector('${toggle}').innerText`)).includes('Filter'), `${w}: visible filter label`);
            await ev(`document.querySelector('${toggle}').click();true`);
            await waitFor(`document.querySelector('${toggle}').getAttribute('aria-expanded')==='true'`, 'filter open');
            await ev(`document.querySelector('#inbox-needs-menu .list-bar-clear-all').click();true`);
            await waitFor(`document.querySelector('${toggle}').getAttribute('aria-expanded')==='false'`, 'Clear closes panel');
            await ev(`document.querySelector('${toggle}').click();window.switchNavTab('agents');true`);
            await openNeeds();
            assert.equal(await ev(`document.querySelector('${toggle}').getAttribute('aria-expanded')`), 'false', `${w}: navigation closes filter`);
        }
        console.log('PASS team identity leads each row and filters close');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
