// #14046 (v2.0.58 regression, coral-hub's QA): the skills that wait are read from each computer through the Hub's /api/remote/<computer>/ and never from the Hub's own origin, which has no Needs you route; the Inbox says
// nothing "could not be read" for a healthy Hub, a computer that fails marks only its own source, and each computer's skill is its own row. The two-computer Hub of helpers/hub_world.js (native boot), desktop width.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const { FOLDER_ROWS } = require('./helpers/folder_rows');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const open = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard'); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native' });

        console.log('1. a healthy Hub: each computer is asked through /api/remote/<computer>/, the Hub origin is never asked, no "could not be read"');
        await open();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`(${FOLDER_ROWS}).some(w => /^All chats/.test(w))`, 'the Inbox folders are on screen', 10000);
        await waitFor(`['m1', 'm2'].every(m => window.__remoteRequests.some(r => r.server === m && r.path === '/api/needs-you' && /kind=skill/.test(r.query)))`, 'both computers were asked for their skills: ' + JSON.stringify(await ev(`window.__remoteRequests.filter(r => r.path === '/api/needs-you')`)), 10000);
        assert.deepEqual(await ev(`window.__bareNeedsYou || []`), [], 'the Hub\'s own origin was never asked for /api/needs-you');
        const healthy = await ev(`(async () => { const g = await import(${S} + 'needs_incomplete.js'), sk = await import(${S} + 'needs_skills.js'); return { note: g.incompleteNote(), count: sk.skillCount(), rows: sk.skillRows().map(r => [r.server, r.session_id, r.display_name]) }; })()`);
        assert.equal(healthy.note, '', 'no "could not be read" for a healthy Hub: ' + JSON.stringify(healthy));
        assert.equal(healthy.count, 2, 'the count is both computers\' skills: ' + JSON.stringify(healthy));
        assert.deepEqual(healthy.rows.map(r => r[0]).sort(), ['m1', 'm2'], 'one row per computer, each on its own computer: ' + JSON.stringify(healthy.rows));
        assert.equal(new Set(healthy.rows.map(r => r[1])).size, 2, 'and their row ids do not collide: ' + JSON.stringify(healthy.rows));
        assert.equal(await ev(`/could not be read/.test(document.body.textContent)`), false, 'no such line on the page');

        console.log('2. one computer fails: only its own source is a gap, the other\'s skill is still drawn');
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__skillsFail = ['m2'];` });
        await open();
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`window.__remoteRequests.some(r => r.server === 'm2' && r.path === '/api/needs-you')`, 'm2 was asked', 10000);
        await waitFor(`import(${S} + 'needs_incomplete.js').then(g => /skills from m2 could not be read/.test(g.incompleteNote()))`, 'the note names m2 alone', 10000);
        const partial = await ev(`(async () => { const g = await import(${S} + 'needs_incomplete.js'), sk = await import(${S} + 'needs_skills.js'); return { note: g.incompleteNote(), rows: sk.skillRows().map(r => r.server), count: sk.skillCount() }; })()`);
        assert.ok(!/m1/.test(partial.note), 'm1 is not named: ' + JSON.stringify(partial));
        assert.deepEqual(partial.rows, ['m1'], 'm1\'s skill is still a row: ' + JSON.stringify(partial));
        assert.equal(partial.count, 1);
        console.log('PASS the skills that wait are read per computer through the Hub, and one computer\'s failure marks only itself');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
