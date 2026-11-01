// On a Hub the shell's top search box is not shown above the Inbox tabs that frame a Hub page (Needs you, Tasks, Saved for later), whose own search is the only one (#11838, coral-hub's request); it is there on
// the tabs that are not a Hub frame (Goals, Artifacts, Chats) and in local mode, where it always was. 1280, the stubbed Hub of helpers/hub_world.js (native boot) and the plain local dev server. Shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const pick = group => ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(group)})).then(() => true)`);
    const shown = () => ev(`(() => { const i = document.getElementById('inbox-search'), box = i && i.closest('.sidebar-search'); return { input: !!i && i.getClientRects().length > 0, box: !!box && box.getClientRects().length > 0 }; })()`);
    const open = async group => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`); await pick(group);
    };
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        // local mode: the box is there on Needs you and Tasks, as it was
        for (const group of ['needs', 'tasks', 'saved']) { await open(group); await waitFor(`document.getElementById('inbox-search')?.getClientRects().length > 0`, `local ${group}: the box`, 8000); const s = await shown(); assert.ok(s.input && s.box, `local ${group}: the top search is shown ${JSON.stringify(s)}`); }
        await shot('hub-search-local-needs-1280');
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native' });
        for (const group of ['needs', 'tasks', 'saved']) {
            await open(group); await waitFor(`!!document.querySelector('#group-table-view iframe.inbox-frame')`, `the ${group} frame`, 10000);
            const s = await shown(); assert.ok(!s.input && !s.box, `Hub ${group}: the frame has its own search, so the shell's top search is not shown ${JSON.stringify(s)}`);
            if (group === 'needs') await shot('hub-search-hidden-needs-1280');
        }
        for (const group of ['goals', 'artifacts']) {
            await open(group); await waitFor(`document.querySelector('#group-table-view .dt-box, #group-table-view .empty-state, #group-table-view table, #group-table-view p')`, `the ${group} page`, 10000);
            const s = await shown(); await shot(`hub-search-shown-${group}-1280`); assert.ok(s.input && s.box, `Hub ${group} (not a Hub frame): the top search is shown ${JSON.stringify(s)}`);
        }
        // back from a Hub frame to a table tab on the same page: the box returns
        await open('needs'); await pick('goals'); await waitFor(`document.getElementById('inbox-search')?.getClientRects().length > 0`, 'the box returns on Goals', 8000);
        await pick('needs'); await waitFor(`document.getElementById('inbox-search')?.getClientRects().length === 0`, 'and goes again on Needs you', 8000);
        console.log('hub_inbox_search_hidden_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
