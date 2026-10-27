// The Inbox's phone toolbar at 200% text (#9658): the search field, the Filters icon and the Select button fit a 390 px screen, the Select button whole (its words, not "Sele"), by wrapping to a second line
// when the line is full. Tasks folder over the census world, touch, isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(INBOX_WORLD);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tr.dt-mailed').length === 3 && !!document.querySelector('${T} .dt-select-toggle')`, 'the tasks and their Select button', 10000);
        for (const size of ['', '200%']) {
            await ev(`document.documentElement.style.fontSize = ${JSON.stringify(size)}; true`);
            const m = await waitFor(`(() => { const b = document.querySelector('${T} .dt-select-toggle'); return !!b && b.getClientRects().length > 0; })()`, 'Select drawn', 4000).then(() => ev(`(() => { const b = document.querySelector('${T} .dt-select-toggle'), s = document.querySelector('${T} .gt-toolbar input[type=search]'), r = b.getBoundingClientRect(), q = s.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), cut: b.scrollWidth > b.clientWidth, text: b.textContent.trim(), search: Math.round(q.width), over: document.documentElement.scrollWidth - innerWidth }; })()`));
            assert.ok(m.left >= 0 && m.right <= 390 && !m.cut && m.text === 'Select' && m.h >= 44 && m.search >= 120 && m.over <= 1, `${size || '100%'} text: the Select button is whole on screen, the search field keeps room ` + JSON.stringify(m));
            await shot(`inbox-select-390-${size ? '200' : '100'}`);
        }
        console.log('PASS the toolbar fits at 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
