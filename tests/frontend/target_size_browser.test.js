// Target size at 125 and 150% display scaling (#5713, WCAG 2.5.8): the sidebar's kebab and open buttons and the Launch dialog's Back button are smaller than 24 px
// across, so each has an invisible 24 px square that belongs to it. Hit-tested the way a pointer would: a point 11 px from the control's centre, on every side,
// lands on the control. Drives Chrome over CDP against the isolated dev server, at the CSS size Windows gives a 1366x768 screen at 125% and at 150%.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const NA = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, dpr] of [[1093, 614, 1.25], [911, 512, 1.5]]) {
            console.log(`${w}x${h} at ${dpr}`);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: dpr, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await waitFor(`!!document.getElementById('agent-search-input')`, 'the page', 15000);
            const miss = await ev(`(() => { const out = [];
                const cases = [['sidebar-kebab-btn', '<button type="button" class="btn btn-quiet btn-icon btn-xs sidebar-kebab-btn" aria-label="Menu"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>'],
                               ['sidebar-kebab-btn group-kebab-btn', '<button type="button" class="btn btn-quiet btn-icon btn-xs sidebar-kebab-btn group-kebab-btn" aria-label="Menu"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>'],
                               ['folder-copy-btn team-open-btn', '<button type="button" class="folder-copy-btn team-open-btn" style="display:inline-flex" aria-label="Open"><span class="material-icons" style="font-size:14px">open_in_new</span></button>'],
                               ['sidebar-kebab-btn in a session row', '<div class="session-name-row" style="display:flex;align-items:center"><span>an agent</span><button type="button" class="btn btn-quiet btn-icon btn-xs sidebar-kebab-btn" aria-label="Menu"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button></div>'],
                               ['launch-back-btn', '<button type="button" class="launch-back-btn" aria-label="Back"><span class="material-icons">arrow_back</span></button>']];
                for (const [name, html] of cases) {
                    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:200px;top:200px;z-index:2147483647;background:#fff;padding:40px'; host.innerHTML = html; document.body.append(host);
                    const b = host.querySelector('button'); b.style.opacity = '1'; const r = b.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                    for (const [dx, dy] of [[-11, 0], [11, 0], [0, -11], [0, 11]]) { const t = document.elementFromPoint(cx + dx, cy + dy); if (!(t === b || b.contains(t))) out.push(name + ' misses ' + dx + ',' + dy + ' (size ' + Math.round(r.width) + 'x' + Math.round(r.height) + ')'); }
                    const moved = host.getBoundingClientRect(); host.remove(); }
                return out; })()`);
            assert.deepEqual(miss, [], 'each small control has a 24 px target: ' + JSON.stringify(miss));
        }
        // the Back button as the real dialog draws it (#8451, WCAG 2.2 AA 2.5.8): its own box is at least 24 px, not only the invisible hit area around it
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await NA.install(ev); await NA.openNewAgent(ev, waitFor);
        const back = await ev(`(() => { const b = [...document.querySelectorAll('[role=dialog] .launch-back-btn')].find(window.__na.vis); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
        assert.ok(back && back[0] >= 24 && back[1] >= 24, 'the Back button of New agent is ' + JSON.stringify(back) + ' px: its own box is at least 24 by 24');
        console.log('   ✓');
    } finally { await Emulation.clearDeviceMetricsOverride().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
