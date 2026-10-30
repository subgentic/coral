// A Hub with no computer online yet (coral-hub's site demo, #11073): the page asked for the tags and the first page of chats before the computers list arrived, and logged "Failed to load tags: No computers online" and
// "Failed to load paged history sessions: Error: No computers online." Nothing to read from is an empty answer, so the lists are empty and nothing is logged; any other failure still logs (its code is not no_computers). The stubbed Hub of
// helpers/hub_world.js with its computers list emptied, in its Chats-tab and its native-Inbox forms.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

(async () => {
    const { client, Page, Emulation, Runtime, ev, waitFor } = await connect();
    const logged = [];
    await Runtime.enable();
    Runtime.consoleAPICalled(e => { if (e.type === 'error') logged.push(e.args.map(a => a.value ?? a.description ?? '').join(' ')); });
    try {
        for (const native of [false, true]) {
            logged.length = 0;
            await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: native });
            await Page.addScriptToEvaluateOnNewDocument({ source: 'window.__computers.splice(0); window.__noComputers = true;' }); // after the stub's own script: no computer is online
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard', 15000);
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings', 'history'); true`);
            // what the page does with no computer: ask for the tags and the first page of chats, as the Chats tab (or the Inbox's All chats) does
            await ev(`(async () => { const S = window.__coralStatic || '/static/'; const t = await import(S + 'tags.js'); const a = await import(S + 'api.js'); await t.loadAllTags(true); await a.loadHistorySessionsPaged(1, 50); return true; })()`);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: proves a negative, nothing is logged by the reads above or the page's own start
            const noComputers = logged.filter(l => /No computers online/.test(l));
            assert.deepEqual(noComputers, [], `${native ? 'native Inbox' : 'Chats tab'}: no "No computers online" console error: ` + JSON.stringify(logged));
            assert.deepEqual(await ev(`import((window.__coralStatic || '/static/') + 'tags.js').then(m => m.loadAllTags(true))`), [], 'the tags are an empty list');
            console.log(`PASS ${native ? 'native Inbox' : 'Chats tab'}: no computer online logs nothing`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
