// The Hub-served (native) Inbox has Goals, and Artifacts for the owner (#11071, coral-hub's ask, Goal #100). Goals reads GET /api/goals of every online computer (a View route), so its table lists the goals of both
// stubbed computers (m1 and m2); Artifacts reads GET /api/team-artifacts, which the Hub answers owner_only for a grantee: the folder is then not offered, and no error is shown. The two-computer Hub of
// helpers/hub_world.js (native boot), at desktop width.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { FOLDER_ROWS } = require('./helpers/folder_rows');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const open = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard'); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings'); true`); };
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native' });

        console.log('1. the owner: Goals and Artifacts are folders, with their counts');
        await open();
        assert.equal(await ev(`document.body.classList.contains('native-inbox')`), true, 'the Hub boots the native Inbox');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`(${FOLDER_ROWS}).some(w => /^All chats/.test(w))`, 'the Inbox folders are on screen', 10000);
        await waitFor(`(${FOLDER_ROWS}).some(w => /^Goals\\d*$/.test(w)) && (${FOLDER_ROWS}).some(w => /^Artifacts\\d*$/.test(w))`, 'Goals and Artifacts are listed: ' + JSON.stringify(await ev(FOLDER_ROWS)), 10000);
        await waitFor(`(${FOLDER_ROWS}).some(w => /^Goals2$/.test(w))`, 'Goals counts the goals of both computers: ' + JSON.stringify(await ev(FOLDER_ROWS)), 10000);

        console.log('2. Goals opens with the goals of both computers');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => true)`);
        for (const title of ['Goal from m1', 'Goal from m2']) {
            await waitFor(`[...document.querySelectorAll('#group-table-view .dt-primary')].some(e => e.textContent.includes(${JSON.stringify(title)}))`, title + ' is listed', 10000);
        }
        const reads = await ev(`window.__remoteRequests.filter(r => r.path === '/api/goals').map(r => r.server).sort()`);
        assert.ok(reads.includes('m1') && reads.includes('m2'), 'both computers were asked: ' + JSON.stringify(reads));

        console.log('3. Artifacts opens with the artifacts of both computers');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('artifacts')).then(() => true)`);
        for (const name of ['report-m1.md', 'report-m2.md']) {
            await waitFor(`document.getElementById('group-table-view') && document.getElementById('group-table-view').textContent.includes(${JSON.stringify(name)})`, name + ' is listed', 10000);
        }

        console.log('4. one computer allows (m1), one refuses (m2): the folder lists m1\'s artifacts only, and m2 is asked once');
        await ev(`localStorage.removeItem('coral.inbox.tab'); true`);
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__artifactsOwnerOnly = ['m2'];` });
        await open();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`(${FOLDER_ROWS}).some(w => /^Artifacts1$/.test(w))`, 'Artifacts counts m1 only: ' + JSON.stringify(await ev(FOLDER_ROWS)), 10000);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('artifacts')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view') && document.getElementById('group-table-view').textContent.includes('report-m1.md')`, 'm1\'s artifact is listed', 10000);
        assert.equal(await ev(`document.getElementById('group-table-view').textContent.includes('report-m2.md')`), false, 'm2 refused: none of its artifacts');
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => import((window.__coralStatic || '/static/') + 'inbox_tab.js')).then(m => m.selectInboxTab('artifacts')).then(() => true)`);
        assert.equal(await ev(`window.__remoteRequests.filter(r => r.server === 'm2' && r.path === '/api/team-artifacts').length`), 1, 'the computer that refused is asked once for the session');
        assert.equal(await ev(`(${FOLDER_ROWS}).some(w => /^Artifacts/.test(w))`), true, 'the folder stays while one computer allows it');

        console.log('5. a grantee on every computer: no Artifacts folder, a kept Artifacts tab falls back to Needs you, no error');
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__artifactsOwnerOnly = true; try { localStorage.setItem('coral.inbox.tab', 'artifacts'); } catch (e) {}` });
        await open();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`(${FOLDER_ROWS}).some(w => /^Goals\\d*$/.test(w))`, 'Goals is still listed', 10000);
        await waitFor(`window.__remoteRequests.some(r => r.path === '/api/team-artifacts')`, 'Artifacts was asked for', 10000);
        await waitFor(`!(${FOLDER_ROWS}).some(w => /^Artifacts/.test(w))`, 'no Artifacts folder for a grantee: ' + JSON.stringify(await ev(FOLDER_ROWS)), 10000);
        await waitFor(`localStorage.getItem('coral.inbox.tab') !== 'artifacts' || !!document.querySelector('#inbox-nav-list .active, #inbox-nav-list [aria-current]')`, 'the folder on screen is no longer Artifacts', 10000);
        assert.equal(await ev(`/could not be read|owner_only|error/i.test(document.getElementById('toast-container')?.textContent || '') || !!document.querySelector('.toast-error')`), false, 'no error is shown');
        console.log('PASS native Inbox: Goals for everyone, Artifacts where a computer allows them');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
