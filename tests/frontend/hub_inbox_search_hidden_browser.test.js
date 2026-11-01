// A page never shows two search boxes (#11838, #11859): the shell's top search (the sidebar's box on a desktop, the pill's field in the top bar on a phone) is not shown above an Inbox tab that has a search box of its
// own. On a Hub the three tabs that frame a Hub page (Needs you, Tasks, Saved for later) show none of Coral's (the framed page has its own); the Inbox's own tabs (Goals, Artifacts, chats) show the page's box alone. In
// local mode every tab (Needs you, Tasks, Goals, Artifacts, Saved, the chat folders) shows the page's box alone. 1280 and 390 px; the stubbed Hub of helpers/hub_world.js (native boot) and the plain local dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const boxes = () => ev(`[...document.querySelectorAll('input[type=search]')].filter(e => e.getClientRects().length).map(e => e.id || e.className.slice(0, 24))`);
    const open = async (w, mobile, group) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(group)})).then(() => true)`);
        await ev(framesJs(8));
    };
    const OWN = { needs: 'inbox-needs-search', tasks: 'inbox-tk-search', goals: 'inbox-goals-search', artifacts: 'ia-search', saved: 'inbox-saved-search', chats: 'inbox-chats-search', 'chats-active': 'inbox-chats-search' };
    try {
        await Page.enable();
        for (const [w, mobile] of [[1280, false], [390, true]]) for (const [group, own] of Object.entries(OWN)) {
            await open(w, mobile, group);
            await waitFor(`!!document.getElementById(${JSON.stringify(own)})?.getClientRects().length`, `local ${group}: the page's own box`, 10000);
            const b = await boxes();
            assert.deepEqual(b, [own], `local ${group}, ${w} px: one search box, the page's: ${JSON.stringify(b)}`);
            if (group === 'needs') await shot(`one-search-local-needs-${w}`);
        }
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native' });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            for (const group of ['needs', 'tasks', 'saved']) {
                await open(w, mobile, group); await waitFor(`!!document.querySelector('#group-table-view iframe.inbox-frame')`, `the ${group} frame`, 10000);
                const b = await boxes(); assert.deepEqual(b, [], `Hub ${group}, ${w} px: the frame has its own search, none of Coral's is shown: ${JSON.stringify(b)}`);
                if (group === 'needs') await shot(`one-search-hub-needs-${w}`);
            }
            for (const [group, own] of [['goals', 'inbox-goals-search'], ['artifacts', 'ia-search']]) {
                await open(w, mobile, group); await waitFor(`!!document.getElementById(${JSON.stringify(own)})?.getClientRects().length`, `Hub ${group}: the page's own box`, 10000);
                const b = await boxes(); assert.deepEqual(b, [own], `Hub ${group}, ${w} px: one search box, the page's: ${JSON.stringify(b)}`);
            }
        }
        console.log('hub_inbox_search_hidden_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
