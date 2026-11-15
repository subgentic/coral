// #17422 (walk 68): a NEW folder typed under /tmp (it does not exist yet; the launch would make it) showed the Trust switch with no warning, and only after launch did Coral say trust was not applied. The real probe now
// answers for where the folder would be made, so the Trust row says why before launch. No stub: the page asks the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        const shared = (await ev(`navigator.platform`)).startsWith('Mac') ? '/private/tmp' : '/tmp';
        const fresh = shared + '/coral-newfolder-' + Date.now().toString(36) + '/wordgame';
        await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
        await waitFor(`!!document.getElementById('launch-step-team') && getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-template-select option').length > 1`, 'the team step');
        await ev(`{ const d = document.getElementById('launch-team-dir'); d.value = ${JSON.stringify(fresh)}; delete d.dataset.suggested; d.dataset.trustChosen = d.value; d.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        await waitFor(`/shared or shallow/.test(document.getElementById('launch-team-trust')?.closest('.sv-row')?.textContent || '')`, 'the refusal is said in the Trust row for a folder that does not exist yet', 10000);
        const row = await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`);
        assert.match(row, /Each agent will ask about the folder when it starts.*inside your home folder/, row);
        await ev(`window.hideLaunchModal(); true`);
        console.log('PASS a new folder in a shared place is warned about at the Trust switch');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
