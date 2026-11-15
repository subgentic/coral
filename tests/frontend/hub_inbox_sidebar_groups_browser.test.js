// #13256 (the operator, through coral-hub: 'the coral hub inbox has a different layout than the coral local'): the Hub-served Inbox's sidebar used its own list: Artifacts under NEEDS ATTENTION, no FILES or HISTORY group,
// 'Saved for later' for Saved. It now uses local Coral's groups, order and words: NEEDS ATTENTION (Needs you, Tasks, Goals, Saved), FILES (Artifacts), and HISTORY (Activity) only where the Hub serves it (it does not today).
// Local first (the plain dev server), then the stubbed Hub of helpers/hub_world.js (native boot). 1280 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const GROUP_TITLES = ['Needs attention', 'Files', 'History'];
    // the sidebar's first groups as [title, name, name, title, name ...], up to the first group that is not one of the three (the chat folders and boards follow)
    const sidebar = () => ev(`(() => { const nav = [...document.querySelectorAll('nav.view-list-nav')].find(n => [...n.querySelectorAll('.view-list-name')].some(e => e.textContent === 'Needs you')); if (!nav) return null;
        const out = []; for (const e of nav.querySelectorAll('.view-list-title, .view-list-name')) { if (e.classList.contains('view-list-title') && !${JSON.stringify(GROUP_TITLES)}.includes(e.textContent.trim())) break; out.push(e.textContent.trim()); } return out; })()`);
    const open = async () => {
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 844, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(framesJs(8));
        await waitFor(`[...document.querySelectorAll('nav.view-list-nav .view-list-name')].some(e => e.textContent === 'Needs you')`, 'the Inbox sidebar', 10000);
    };
    try {
        await Page.enable();
        console.log('1. Local: Needs attention (Needs you, Tasks, Goals, Saved), Files (Artifacts), History (Activity)');
        await open();
        const local = await sidebar();
        assert.deepEqual(local, ['Needs attention', 'Needs you', 'Tasks', 'Goals', 'Saved', 'Files', 'Artifacts', 'History', 'Activity'], JSON.stringify(local));
        await shot('hub-inbox-sidebar-local');
        console.log('   ✓');

        console.log('2. The Hub-served Inbox: the same groups, order and words; History only where the Hub serves it (not today)');
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native' });
        await open();
        const hub = await sidebar();
        assert.deepEqual(hub, ['Needs attention', 'Needs you', 'Tasks', 'Goals', 'Saved', 'Files', 'Artifacts'], JSON.stringify(hub));
        assert.ok(!hub.includes('Saved for later'), 'the word is Saved, as on a computer');
        await shot('hub-inbox-sidebar-hub');
        console.log('   ✓');

        console.log('3. A Hub folder still opens its page: Saved frames the Hub page, Artifacts is the native list');
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
        await waitFor(`!!document.querySelector('#group-table-view iframe.inbox-frame')`, 'the Saved frame', 10000);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('artifacts')).then(() => true)`);
        await waitFor(`!document.querySelector('#group-table-view iframe.inbox-frame')`, 'Artifacts is not a frame', 10000);
        console.log('   ✓');
        console.log('PASS hub inbox sidebar: the Hub-served sidebar uses local\'s groups, order and words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
