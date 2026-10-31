// The Docs tab for a first-time reader (#11401 e, from the Mobile Beta Tester's walk): "Getting started" is open and "For developers" (32 API pages) is folded under it, so a newcomer does not scroll past 32 pages to
// reach what a search or the next section would show. A search still shows its hits in both groups, and a reader who opens the group keeps it open. At 390 and 1280, against the real docs of the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const state = () => ev(`(() => { const o = {}; for (const h of document.querySelectorAll('#docs-nav-list .sgroup-header')) { const k = h.dataset.group; o[k] = { expanded: h.querySelector('.group-chevron').getAttribute('aria-expanded'), rows: 0 }; } let cur = null; for (const li of document.querySelectorAll('#docs-nav-list > li')) { if (li.classList.contains('sgroup-header')) cur = li.dataset.group; else if (cur && li.querySelector('[data-doc]')) o[cur].rows++; } return o; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral-sidebar-groups-docs'); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('docs'); true`);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length >= 3`, `${w}: the topics`, 12000);
            let s = await state();
            assert.equal(s['getting-started'].expanded, 'true', `${w}: Getting started is open: ${JSON.stringify(s)}`); assert.ok(s['getting-started'].rows >= 4, `${w}: its topics are listed`);
            assert.equal(s.api.expanded, 'false', `${w}: For developers is folded for a first-time reader: ${JSON.stringify(s)}`); assert.equal(s.api.rows, 0, `${w}: none of its 30-odd pages are listed`);
            await shot(`docs-first-look-${w}`);
            // a search shows its hits wherever they are
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'docs.js'); m.filterDocs('sessions'); return true; })()`);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length >= 1 && !!document.querySelector('#docs-nav-list [data-doc="sessions"]')`, `${w}: the search shows an API page`, 10000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'docs.js'); m.filterDocs(''); return true; })()`);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc="sessions"]').length === 0`, `${w}: the search cleared, the group folded again`, 8000);
            // a topic of the folded group opened from a link shows in its group (an API page from a route)
            await ev(`(async () => { await window.selectDoc('hooks', { noteRoute: false }); return true; })()`);
            await waitFor(`!!document.querySelector('#docs-nav-list [data-doc="hooks"].row-btn, #docs-nav-list li.active [data-doc="hooks"], #docs-nav-list [data-doc="hooks"]')`, `${w}: the opened API topic is in the list`, 8000);
            s = await state(); assert.equal(s.api.expanded, 'true', `${w}: its group opened with it: ${JSON.stringify(s)}`);
            await ev(`localStorage.removeItem('coral-sidebar-groups-docs'); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('docs'); true`);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length >= 3`, `${w}: the topics once more`, 12000);
            // opening the group keeps it open
            await ev(`document.querySelector('#docs-nav-list .group-chevron[data-group="api"]').click(); true`);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length > 10`, `${w}: For developers opened`, 8000);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('docs'); true`);
            await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length >= 3`, `${w}: the topics again`, 12000);
            s = await state();
            assert.equal(s.api.expanded, 'true', `${w}: a reader who opened For developers finds it open: ${JSON.stringify(s)}`);
        }
        console.log('PASS docs first look: For developers folded for a new reader, a search shows its hits, an opened group stays open');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
