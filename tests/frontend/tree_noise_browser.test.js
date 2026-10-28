// The start page's accessibility tree carries no noise nodes (Beta #10372 finding 8, #10452): the icons of the top bar's gear and the sidebar's Hide button were unnamed "image" nodes beside the named buttons that hold them. Every
// decorative icon in the page's own markup is hidden from the tree (aria-hidden) where its button already has a name; the tree at start has no image node without a name. Read from the accessibility tree at 1366 x 768 on the
// Agents tab and the Inbox. The empty status regions stay: they are the live regions announcements are written into (the live-region census requires them), so a reader hears a change. Drives Chrome over CDP through
// agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axNodes } = require('./helpers/ax_tree');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await client.Accessibility.enable(); await client.DOM.enable();
        for (const tab of ['agents', 'hub-inbox']) {
            await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`); await new Promise(r => setTimeout(r, 1000)); // sleep-ok: the tab draws
            const nodes = await axNodes(client.Accessibility);
            const bare = nodes.filter(n => n.role && ['image', 'img'].includes(n.role.value) && !(n.name && n.name.value));
            const where = [];
            for (const n of bare) {
                if (!n.backendDOMNodeId) { where.push('?'); continue; }
                try { const { object } = await client.DOM.resolveNode({ backendNodeId: n.backendDOMNodeId }); const r = await client.Runtime.callFunctionOn({ objectId: object.objectId, functionDeclaration: 'function() { const p = this.closest("button, a, [role=button]"); return this.tagName + " in " + (p ? (p.getAttribute("aria-label") || p.id || p.className) : this.parentElement.className) }', returnByValue: true }); where.push(r.result.value); } catch { where.push('?'); }
            }
            if (bare.length) problems.push(`${tab}: unnamed image nodes in the tree: ${JSON.stringify(where)}`);
        }
        // the markup: no decorative svg left without aria-hidden, a role or a title in the page's own templates
        const loose = await ev(`[...document.querySelectorAll('button svg, a svg, summary svg')].filter(s => !s.closest('[aria-hidden=true]') && !s.hasAttribute('aria-hidden') && !s.getAttribute('role') && !s.getAttribute('aria-label') && !s.querySelector('title') && (s.closest('button, a, summary').getAttribute('aria-label') || s.closest('button, a, summary').textContent.trim())).map(s => (s.closest('button, a, summary').getAttribute('aria-label') || s.closest('button, a, summary').textContent.trim()).slice(0, 30) + ' | ' + s.closest('button, a, summary').className.toString().slice(0, 30))`);
        if (loose.length) problems.push(`${loose.length} icons inside a named button are not hidden from the tree: ${JSON.stringify(loose)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'noise in the start page tree:\n  ' + problems.join('\n  '));
    console.log('PASS the start page tree has no unnamed image nodes');
})().catch(e => { console.error(e); process.exit(1); });
