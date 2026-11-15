// A Hub page framed in the Inbox (Needs you, Tasks, Saved) is loaded once and stays loaded across folder switches (#17584, coral-hub's request): the iframe is not taken out of the page and put back (which loads its page
// again, 260-310 ms and a flash of other screens); it stays attached and hidden while another folder shows, and is shown again where it is. Stubbed Hub of helpers/hub_world.js (hubPages): the frame's load events are
// counted on the element. Phone (390) and desktop (1280). A change of the frame's address still loads it again.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { framesJs } = require('./helpers/wait');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    const pick = group => ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(group)})).then(() => true)`);
    const frames = () => ev(`[...document.querySelectorAll('#group-table-view iframe')].map(f => ({ src: f.getAttribute('src'), hidden: f.hidden, mark: f.__mark || '', loads: Number(f.dataset.loads || 0), h: Math.round(f.getBoundingClientRect().height) }))`);
    const mark = group => ev(`(() => { const f = [...document.querySelectorAll('#group-table-view iframe')].find(x => x.getAttribute('src') === '/inbox/hub/${group}'); if (!f) return false; f.__mark = '${group}'; if (!f.__counted) { f.__counted = true; f.dataset.loads = '0'; f.addEventListener('load', () => { f.dataset.loads = String(Number(f.dataset.loads) + 1); }); } return true; })()`);
    let native = true;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 390, height: 844, mobile: true, inbox: () => native, hubPages: true });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
            await coralReady('startup', 'liveList', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await pick('needs'); await waitFor(`!!document.querySelector('#group-table-view iframe[src="/inbox/hub/needs"]:not([hidden])')`, at + 'the Needs you frame', 10000, `JSON.stringify({ nav: document.body.className, view: (document.getElementById('group-table-view') || {}).outerHTML?.slice(0, 600), mode: document.documentElement.outerHTML.match(/"inbox":"[a-z]*"/) })`);
            await waitFor(`${await mark('needs')}`, at + 'marked', 3000);
            await ev(framesJs(10));
            await pick('tasks'); await waitFor(`!!document.querySelector('#group-table-view iframe[src="/inbox/hub/tasks"]:not([hidden])')`, at + 'the Tasks frame', 10000);
            await mark('tasks');
            await pick('saved'); await waitFor(`!!document.querySelector('#group-table-view iframe[src="/inbox/hub/saved"]:not([hidden])')`, at + 'the Saved frame', 10000);
            await mark('saved');
            await ev(framesJs(10));
            for (const g of ['needs', 'tasks', 'saved', 'needs']) { // back and forth: each shows its own frame, the others stay attached and hidden
                await pick(g); await waitFor(`!!document.querySelector('#group-table-view iframe[src="/inbox/hub/${g}"]:not([hidden])')`, at + `${g} is shown again`, 10000);
                await ev(framesJs(6));
                const fs = await frames();
                const shown = fs.filter(f => !f.hidden);
                assert.equal(shown.length, 1, at + `${g}: one frame shows, the others are hidden: ` + JSON.stringify(fs));
                assert.equal(shown[0].src, `/inbox/hub/${g}`, at + `${g}: the shown frame is its own: ` + JSON.stringify(fs));
                assert.ok(shown[0].h > 100, at + `${g}: the shown frame has room: ` + JSON.stringify(fs));
                assert.ok(fs.length === 3 && fs.every(f => f.mark), at + `${g}: all three frames are the same elements, still attached (never replaced): ` + JSON.stringify(fs));
                assert.ok(fs.every(f => f.loads <= 1), at + `${g}: no frame loaded its page more than once: ` + JSON.stringify(fs));
            }
            console.log(`PASS ${w}: the three Hub frames stay attached and load once across switches`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
