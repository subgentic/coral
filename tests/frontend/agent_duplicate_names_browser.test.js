// Two agents nobody named, in one folder, are told apart in every place the dashboard names an agent (#10249, Mobile #10198): the server numbers the later one (name_number) and the shared identity resolver, which the sidebar
// row, the toast, the Inbox row and the header all read, draws "<name> 2". A person's own rename, a board job title and the first agent keep their plain names. The resolver is checked by itself, then the sidebar
// draws two unnamed agents. 1280 px, isolated dev server.
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
        const r = await ev(`import((window.__coralStatic || '/static/') + 'session_state.js').then(m => { const id = m.resolveSessionIdentity, home = { agent_type: 'claude', working_directory: '' }; return {
            first: id({ ...home, name_number: 1 }), older: id({ ...home }), second: id({ ...home, name_number: 2 }), third: id({ ...home, name_number: 3 }),
            folder: id({ agent_type: 'claude', working_directory: '/work/my-app', name_number: 2 }), named: id({ ...home, display_name: 'Reviewer', name_number: 2 }),
            job: id({ ...home, board_job_title: 'Backend Dev', name_number: 2 }), term: id({ agent_type: 'terminal', name_number: 2 }), plain: m.defaultAgentName('', 'claude') }; })`);
        assert.deepEqual(r, { first: 'Claude', older: 'Claude', second: 'Claude 2', third: 'Claude 3', folder: 'my-app 2', named: 'Reviewer', job: 'Backend Dev', term: 'Terminal', plain: 'Claude' }, JSON.stringify(r));
        console.log('1. the resolver numbers a duplicate and leaves a name alone');

        await ev(`(() => { const rows = [1, 2].map(n => ({ session_id: 'dup-' + n, name: 'dup-' + n, agent_type: 'claude', working_directory: '', server: 'local', sleeping: false, archived: false, status: 'idle', name_number: n, board_project: null }));
            window.T.state.liveSessions = rows; window.T.render.renderLiveSessions(rows); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list li[data-session-id^="dup-"]').length === 2`, 'the two rows', 8000);
        const labels = await ev(`[...document.querySelectorAll('#live-sessions-list li[data-session-id^="dup-"] .session-label-name')].map(e => e.textContent.trim())`);
        assert.deepEqual(labels, ['Claude', 'Claude 2'], 'the sidebar rows are told apart: ' + JSON.stringify(labels));
        console.log('PASS two unnamed agents are Claude and Claude 2');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
