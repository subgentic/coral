// The phone's side panel tabs say their words (#17242, walk 57 F4): at 390 the tabs were icons alone until one was opened, so Activity took a guess; the strip scrolls, so every shown tab carries
// its word and its name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`(async () => { localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('phone-agent', 'P', 3, { sleeping: false }); await window.selectLiveSession('phone-agent', 'claude', 'phone-agent-id', 'local'); return true; })()`);
        await ev(`(async () => { const b = document.getElementById('panel-toggle-btn'); if (b && b.getBoundingClientRect().width > 0) b.click(); else (await import((window.__coralStatic || '/static/') + 'sidebar.js')).toggleAgenticPanel(true); return true; })()`);
        await waitFor(`document.getElementById('agentic-state').classList.contains('mobile-panel-overlay')`, 'the panel overlay', 5000);
        await sleep(400); // sleep-ok: the tab row measures its words after the panel opens
        const tabs = await ev(`[...document.querySelectorAll('#agentic-state .agentic-state-tabs .agentic-tab')].filter(t => t.getBoundingClientRect().width > 0 && getComputedStyle(t).display !== 'none' && !t.classList.contains('tab-more')).map(t => { const w = t.querySelector('.agentic-tab-word'); return { id: t.id, label: t.getAttribute('aria-label'), word: w && getComputedStyle(w).display !== 'none' ? w.textContent.trim() : '' }; })`);
        assert.ok(tabs.length >= 4, 'the panel shows its tabs: ' + JSON.stringify(tabs));
        const bare = tabs.filter(t => ['agentic-tab-files', 'agentic-tab-artifacts', 'agentic-tab-tasks'].includes(t.id)).filter(t => !t.word || !t.label).map(t => t.id);
        assert.deepEqual(bare, [], 'every tab of the phone panel shows its word and has its name: ' + JSON.stringify(tabs));
        console.log('PASS phone panel tabs: ' + tabs.length + ' tabs, each with its word (' + tabs.map(t => t.word).join(', ') + ')');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
