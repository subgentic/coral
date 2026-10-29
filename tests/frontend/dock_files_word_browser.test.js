// The Files tab keeps its word when the side panel narrows (#10876, #10737 remainder): at the panel's narrowest width the open Files tab still says "Files" beside its icon, on one line, nothing clipped, even when
// another tab's word (Artifacts) would not fit as the open one. 1280 px, the real dashboard over CDP, an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const ROW = '#agentic-block-top .agentic-state-tabs';
    const word = tab => ev(`(() => { const r = document.querySelector('${ROW}'), b = document.getElementById('agentic-tab-${tab}'), w = b.querySelector('.agentic-tab-word'); return { word: w && getComputedStyle(w).display !== 'none' ? w.textContent : null, clipped: r.scrollWidth > r.clientWidth || b.scrollWidth > b.clientWidth + 1, tops: [...new Set([...r.querySelectorAll('.agentic-tab')].filter(x => getComputedStyle(x).display !== 'none' && !x.classList.contains('tab-more')).map(x => x.offsetTop))].length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`localStorage.removeItem('coral-agentic-tab-prefs'); window.__m.add('dock-bot', 'A', 3, { sleeping: false }); true`);
        await settle(ev, 600); // sleep-ok: the first live list renders from several answers
        await ev(`window.selectLiveSession('dock-bot', 'claude', 'dock-bot-id', 'local'); true`);
        await ev(`(() => { const p = document.getElementById('agentic-state'); if (p.classList.contains('collapsed') || document.getElementById('agentic-tab-files').getBoundingClientRect().width === 0) window.toggleAgenticPanel(true); return true; })()`);
        await waitFor(`document.getElementById('agentic-tab-files').getBoundingClientRect().width > 0 && !document.getElementById('agentic-tab-more').hidden`, 'the panel', 8000);
        await ev(`document.getElementById('agentic-tab-files').click(); document.documentElement.style.fontSize = '17px'; document.getElementById('files-bar-count').textContent = '128'; document.getElementById('agentic-tab-board').style.display = ''; true`); // a busy team agent at a slightly larger text size: the Files count, and the Board tab in the row
        for (const w of [280, 300, 320]) {
            await ev(`document.getElementById('agentic-state').style.width = '${w}px'; window.dispatchEvent(new Event('resize')); true`); await settle(ev, 500); // sleep-ok: the row is measured again
            const f = await word('files');
            assert.ok(f.word === 'Files' && !f.clipped && f.tops === 1, `${w} px: the open Files tab says Files, one line, nothing clipped: ` + JSON.stringify(f));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
