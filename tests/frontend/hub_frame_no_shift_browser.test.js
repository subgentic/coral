// A Hub page framed in the Inbox (Needs you, Tasks, Saved: #9542) does not move once it is on screen (#20836, coral-hub #266014): after Mark done in Saved the frame went up 30 px, then 30 px again. The page
// holding the frame was a scroller 57 px taller than its window (the frame is 100% of the page's content box, the heading is above it), so anything in the frame that scrolled itself into view (a notice
// appearing, a button taking focus) scrolled the page and slid the frame under the heading, and a click aimed at the next button (Reopen) hit the row. The page has no scroll range now. The stubbed Hub of
// helpers/hub_world.js stands in for the Hub's pages; the frame's own page is made to scroll itself into view the way a notice does.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    await setupHubWorld({ client, Page, Emulation, width: 1440, height: 900, mobile: false, inbox: () => true, hubPages: true });
    const failures = [];
    for (const [w, h] of [[1440, 900], [1100, 700], [820, 600]]) {
        for (const group of ['saved', 'needs', 'tasks']) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
            await coralReady('startup', 'liveList', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(group)})).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view iframe.inbox-frame')`, `the ${group} frame`, 10000);
            await settle(400);
            const where = `${group} ${w}x${h}`;
            const before = await ev(`(() => { const v = document.getElementById('group-table-view'), f = v.querySelector('iframe.inbox-frame'), r = f.getBoundingClientRect(), vr = v.getBoundingClientRect(), pad = parseFloat(getComputedStyle(v).paddingBottom);
                return { top: r.top, bottom: r.bottom, range: v.scrollHeight - v.clientHeight, viewBottom: vr.bottom, pad }; })()`);
            // the frame's page scrolls its last element into view, as a status notice or a focused button does
            await ev(`(() => { const d = document.querySelector('#group-table-view iframe.inbox-frame').contentDocument; const el = d.createElement('div'); el.style.cssText = 'height:2000px'; d.body.append(el); const end = d.createElement('button'); end.textContent = 'Reopen'; d.body.append(end); end.scrollIntoView(); end.focus(); return true; })()`);
            await settle(300);
            const after = await ev(`(() => { const v = document.getElementById('group-table-view'), f = v.querySelector('iframe.inbox-frame'); return { top: f.getBoundingClientRect().top, scrollTop: v.scrollTop }; })()`);
            const line = `${where}: ${JSON.stringify({ before, after })}`;
            console.log(line);
            if (before.range > 1) failures.push(`${where}: the page holding the frame can scroll by ${before.range}px`);
            if (Math.abs(after.top - before.top) > 0.5) failures.push(`${where}: the frame moved ${before.top - after.top}px when its page scrolled itself into view`);
            if (before.bottom > before.viewBottom - before.pad + 0.5) failures.push(`${where}: the frame ends past the page's padding (${before.bottom} > ${before.viewBottom - before.pad})`);
        }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
    console.log('PASS the Hub page frames do not move when their page scrolls itself into view');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
