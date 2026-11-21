// coral-hub #258906 item 3 (#20428): Coral Hub's Skills page names the computer it reads in its note ("This is Laptop's list, read only."), never "This is This computer's list"; with no computer there is no such note. The stubbed two-computer Hub (helpers/hub_world). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        const note = () => ev(`(document.querySelector('.skills-note') || {}).textContent || ''`);
        const open = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'skills_tab.js'); await m.showSkillsTab(); return true; })()`);
        await open();
        await waitFor(`/read only/.test((document.querySelector('.skills-note') || {}).textContent || '')`, 'the note names the computer', 10000);
        assert.match(await note(), /^This is Laptop's list, read only\./, 'the note names the computer it reads: ' + await note());
        await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.servers = []; return true; })()`);
        await open();
        const t = await ev(`document.body.innerText`);
        assert.ok(!/This is [Tt]his computer's list/.test(t), 'with no computer the note does not say "This is this computer\\u2019s list"');
        console.log('PASS hub skills note words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
