// Light-theme contrast the Beta tester found (#10209, Beta #10202): Docs code blocks (the plain code colour was the dark theme's pale grey on a light grey block) and the launch dialog's type cards (their edge was
// 1.4:1 against the dialog). Text 4.5:1 and a component's edge 3:1 (helpers/contrast.js does the measuring). Isolated dev server, 1280 px, the light theme.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await installAudit(ev);
        await setTheme(ev, 'light');
        // 1. a Docs code block: its plain text and every token colour against the block
        await ev(`import((window.__coralStatic || '/static/') + 'vendor_loader.js').then(m => m.loadHighlight()).then(() => true)`); // highlight.js's own style sheet (github-dark), as a page that has shown code has it
        // the Docs page's own rules style `.docs-content pre`; its code, as highlight.js writes it, in a box of the page's colours
        await ev(`(() => { document.getElementById('cc-box')?.remove(); const b = document.createElement('div'); b.id = 'cc-box'; b.className = 'docs-content'; b.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:300px;overflow:auto;background:var(--bg-primary);z-index:99999;padding:12px';
            b.innerHTML = '<pre><code class="hljs language-bash"><span class="hljs-comment"># a script you run yourself</span>\\nNAME=$(coral agent name)\\nQuick safety check: Is <span class="hljs-keyword">this</span> a project you created?\\ncurl -s <span class="hljs-string">"http://localhost:8420/api"</span> -X POST <span class="hljs-attr">--data</span> <span class="hljs-number">42</span></code></pre>'; document.body.appendChild(b); return true; })()`);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the box paints
        const docs = await auditRegion(ev, ['#cc-box']);
        assert.ok(docs.checked > 5, 'the audit saw the code block: ' + docs.checked);
        assert.deepEqual(docs.fails, [], 'every word of a Docs code block is 4.5:1 in the light theme: ' + JSON.stringify(docs.fails.slice(0, 5)));
        // 2. the launch dialog's type cards: their edge 3:1
        await ev(`window.showLaunchModal(); true`);
        await waitFor(`[...document.querySelectorAll('#launch-modal .launch-type-card')].filter(e => e.getClientRects().length > 0).length >= 3`, 'the type cards', 8000);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the dialog paints
        const launch = await auditRegion(ev, ['#launch-modal']);
        const cardEdges = launch.borders.filter(b => /launch-type-card/.test(b.sel));
        assert.deepEqual(cardEdges, [], 'the launch dialog\'s cards have an edge of at least 3:1: ' + JSON.stringify(cardEdges.slice(0, 2)));
        assert.deepEqual(launch.fails, [], 'the launch dialog\'s words are 4.5:1: ' + JSON.stringify(launch.fails.slice(0, 3)));
        console.log('PASS light-theme contrast: Docs code blocks and the launch dialog cards');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
