// #11583 (the operator, in dark mode: the Inbox's tab strip cut its last tab, 'Sa...', with no sign it scrolls): the phone's tab strip (the view list with `tabs`) is five tabs (Needs you, Tasks, Goals, Artifacts, Saved)
// with their counts, wider than a 390 or a 360 px screen. While there is more to the right the strip says so with a chevron at its edge (data-overflow on the strip, a ::after on the list); scrolled to the end, the last tab
// is whole inside the strip and the chevron is gone; a strip that fits (600 px) draws none. The real view_list.js and stylesheet, dark theme.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fits] of [[390, false], [360, false], [600, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            const r = await ev(`(async () => { document.documentElement.setAttribute('data-theme', 'dark'); const VL = await import(${S} + 'view_list.js');
                const host = document.body.appendChild(document.createElement('div')); host.id = 'tabs-probe'; host.style.cssText = 'position:fixed;left:0;top:100px;width:100%;z-index:99999;background:#111';
                const items = [{ key: 'needs', label: 'Needs you', count: 3, alert: true }, { key: 'tasks', label: 'Tasks', count: 12 }, { key: 'goals', label: 'Goals', count: 4 }, { key: 'artifacts', label: 'Artifacts', count: 9 }, { key: 'saved', label: 'Saved', count: 2 }];
                const root = VL.build({ id: 'probe', label: 'Inbox views', tabs: true, current: 'needs', sections: [{ items }], onPick() {} }); host.append(root);
                const nav = root.querySelector('.view-list-nav'), wait = () => new Promise(r => setTimeout(r, 250)); // sleep-ok: the scroll event and the resize observer settle
                const cue = () => { const p = getComputedStyle(root, '::after'); return p.content !== 'none' && parseFloat(p.width) > 0; };
                await wait(); const start = { over: nav.hasAttribute('data-overflow'), cue: cue(), overflow: nav.scrollWidth > nav.clientWidth };
                nav.scrollLeft = nav.scrollWidth; await wait(); const tabs = [...nav.querySelectorAll('.vl-tab')], last = tabs[tabs.length - 1].getBoundingClientRect(), nr = nav.getBoundingClientRect();
                return { start, end: { over: nav.hasAttribute('data-overflow'), cue: cue(), lastInside: Math.round(last.right) <= Math.round(nr.right) && Math.round(last.left) >= 0, lastRight: Math.round(last.right), navRight: Math.round(nr.right) } }; })()`);
            if (fits) assert.deepEqual([r.start.overflow, r.start.over, r.start.cue], [false, false, false], `${w}: a strip that fits draws no cue: ${JSON.stringify(r)}`);
            else {
                assert.ok(r.start.overflow, `${w}: the five tabs are wider than the screen (the case): ${JSON.stringify(r)}`);
                assert.ok(r.start.over && r.start.cue, `${w}: the strip says there is more to the right: ${JSON.stringify(r)}`);
                assert.ok(!r.end.over && !r.end.cue, `${w}: at the end the cue is gone: ${JSON.stringify(r)}`);
                assert.ok(r.end.lastInside, `${w}: scrolled to the end, Saved is whole inside the strip: ${JSON.stringify(r)}`);
            }
        }
        console.log('\nPASS the phone tab strip says it scrolls');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
