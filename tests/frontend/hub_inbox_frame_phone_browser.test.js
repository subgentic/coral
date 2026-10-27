// A Hub page framed in the Hub-served Inbox (Needs you, Tasks, Saved for later: #9542) on a phone (#9660, UI/UX's 22:34 check): the folder button names the page, so there is no heading under it, and the frame runs
// edge to edge (no gutter, no panel fill). A desktop keeps its heading and its gutter. The stubbed two-computer Hub of helpers/hub_world.js (native boot); the frame's address is the Hub's page, which this test
// server does not serve: only the frame's place is tested. Shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); await settle(300); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, h, mobile, group) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(group)})).then(() => true)`);
        await waitFor(`!!document.querySelector('#group-table-view iframe.inbox-frame')`, `the ${group} frame`, 10000);
    };
    const probe = () => ev(`(() => { const v = document.getElementById('group-table-view'), f = v.querySelector('iframe.inbox-frame'), r = f.getBoundingClientRect(), cs = getComputedStyle(v); return { src: f.getAttribute('src'), heading: !!document.getElementById('group-table-title'), headingShown: !!document.getElementById('group-table-title'), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), vw: innerWidth, padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight), padT: parseFloat(cs.paddingTop), fillAbove: getComputedStyle(f).backgroundColor }; })()`);
    try {
        await setupHubWorld({ client, Page, Emulation, width: 390, height: 844, mobile: true, inbox: 'native' });
        for (const [group, src] of [['needs', '/inbox/hub/needs'], ['tasks', '/inbox/hub/tasks'], ['saved', '/inbox/hub/saved']]) {
            await open(390, 844, true, group);
            const p = await probe();
            assert.equal(p.src, src, `${group}: the frame is the Hub page at its constant address`);
            assert.equal(p.headingShown, false, `${group}, 390: no heading under the folder button (it names the page) ${JSON.stringify(p)}`);
            assert.ok(p.left === 0 && p.width === p.vw, `${group}, 390: the frame runs edge to edge ${JSON.stringify(p)}`);
            assert.ok(p.padL === 0 && p.padR === 0 && p.padT === 0, `${group}, 390: no gutter round the frame ${JSON.stringify(p)}`);
            if (group === 'needs') await shot('hub-inbox-framed-390-edge');
            console.log(`PASS 390 ${group}: no heading, edge to edge`);
        }
        await open(1280, 800, false, 'needs');
        const d = await probe();
        assert.equal(d.headingShown, true, `1280: a desktop keeps the page heading ${JSON.stringify(d)}`);
        assert.ok(d.padL > 0 && d.left > 0, `1280: and its gutter ${JSON.stringify(d)}`);
        console.log('PASS 1280: heading and gutter as before');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
