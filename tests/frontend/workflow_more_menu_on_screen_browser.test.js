// A menu stays inside the screen (Mobile pass 19, #10267, #10275): on a workflow's page at 390 px the More menu opened at x = -90, with Delete cut off at the left, because the menu hangs from the right edge of a
// button that sits at the left of the bar. Now every item of the menu is wholly on screen, at 390 and at 320 px, at 200% text, and on a desktop; a real workflow on the isolated dev server (removed again).
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const name = 'wfmenu-' + Date.now().toString(36);
    const problems = [];
    let id = 0;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        const r = await api('POST', '/api/workflows', { name, description: 'A workflow for the menu', max_duration_s: 300, steps: [{ name: 'Step', type: 'shell', command: 'echo hi' }] });
        assert.ok(r.status < 300, JSON.stringify(r)); id = r.body.id;
        for (const [w, h, mobile, font] of [[1280, 900, false, ''], [390, 844, true, ''], [320, 568, true, ''], [390, 844, true, '32px']]) {
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            if (font) await ev(`document.documentElement.style.fontSize = '${font}'; true`);
            await ev(`window.openAutomationsFolder('workflows'); true`);
            await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].some(c => c.textContent.includes(${JSON.stringify(name)}))`, `${tag}: the workflow row`, 10000);
            await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].find(c => c.textContent.includes(${JSON.stringify(name)})).click(); true`);
            await waitFor(`!!document.querySelector('.wf-more-btn')`, `${tag}: the workflow page`, 12000);
            await ev(`document.querySelector('.wf-more-btn').scrollIntoView({ block: 'center' }); true`); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the scroll settles
            await ev(`document.querySelector('.wf-more-btn').click(); true`);
            await waitFor(`!document.querySelector('.wf-more-menu').hidden`, `${tag}: More opens`, 4000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the menu is placed after it opens
            const m = await ev(`(() => { const menu = document.querySelector('.wf-more-menu'), b = menu.getBoundingClientRect(); return { menu: [b.left, b.top, b.right, b.bottom].map(Math.round), vw: innerWidth, vh: innerHeight, items: [...menu.querySelectorAll('button')].map(i => { const r = i.getBoundingClientRect(); return { t: i.textContent.trim(), l: Math.round(r.left), r: Math.round(r.right), t0: Math.round(r.top), b: Math.round(r.bottom) }; }) }; })()`);
            const ok = m.menu[0] >= 0 && m.menu[2] <= m.vw && m.menu[1] >= 0 && m.menu[3] <= m.vh && m.items.length > 0 && m.items.every(i => i.l >= 0 && i.r <= m.vw && i.t0 >= 0 && i.b <= m.vh);
            if (!ok) problems.push(`${tag}: the More menu is inside the screen (${m.vw} x ${m.vh}): ${JSON.stringify(m)}`);
            const hit = await ev(`(() => { const i = document.querySelector('.wf-more-menu button'); const r = i.getBoundingClientRect(); const t = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), r.top + r.height / 2); return !!t && (t === i || i.contains(t)); })()`);
            if (!hit) problems.push(`${tag}: Delete is what a tap at its centre reaches`);
        }
    } finally {
        if (id) await api('DELETE', `/api/workflows/${id}`).catch(() => {});
        await client.close();
    }
    assert.deepEqual(problems, [], 'the workflow page\'s More menu:\n  ' + problems.join('\n  '));
    console.log('PASS the workflow More menu is inside the screen');
})().catch(e => { console.error(e); process.exit(1); });
