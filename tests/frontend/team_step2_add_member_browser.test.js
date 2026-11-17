// New team step 2 on a tablet (820 x 1180, touch; walk 80 #12): Add member is whole and clear of the footer, and the footer's line ("Set the model of N workers.") does not cover it.
// Isolated dev server; the helpers are launch_footer_inline's.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');
const { install: installNT, openNewTeam, T } = require('./helpers/new_team');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['820x1180', 820, 1180, true], ['1024x768', 1024, 768, true], ['1440x900', 1440, 900, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
            await stubModels(ev); await stubCliChecks(ev, []);
            await installNT(ev); await openNewTeam(ev, waitFor); await T(ev, waitFor).to(2, { template: /Coding/ });
            await waitFor(`document.getElementById('team-recap').textContent.trim().length > 0`, `${label}: the line is drawn`, 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the footer is fitted after the line is drawn
            const g = await ev(`(() => { const r = e => { if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; }; const add = document.querySelector('#launch-step-team .team-add-agent-btn'); const bx = add && add.getBoundingClientRect(); const cx = bx && document.elementFromPoint(bx.left + bx.width / 2, bx.top + bx.height / 2); const pane = add && add.closest('.team-page, .launch-page, .modal-body'); return { add: r(add), recap: r(document.getElementById('team-recap')), actions: r(document.querySelector('#launch-step-team > .modal-actions')), pane: r(pane), paneClass: pane && pane.className, hit: !!(cx && add.contains(cx)), hitClass: cx && String(cx.className).slice(0, 40), vh: innerHeight }; })()`);
            await ev(`(() => { const a = document.querySelector('#launch-step-team .team-add-agent-btn'); for (let e = a; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; return true; })()`); // the very end of every scrolling box above it await new Promise(r => setTimeout(r, 200)); // sleep-ok: the scroll settles
            const s = await ev(`(() => { const r = e => { if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; }; const add = document.querySelector('#launch-step-team .team-add-agent-btn'); const bx = add.getBoundingClientRect(); const cx = document.elementFromPoint(bx.left + bx.width / 2, bx.top + bx.height / 2); return { add: r(add), recap: r(document.getElementById('team-recap')), actions: r(document.querySelector('#launch-step-team > .modal-actions')), g0: null, hit: add.contains(cx), hitClass: cx && String(cx.className).slice(0, 40) }; })()`);
            const cover = o => o.add && o.recap && o.add.l < o.recap.r && o.add.r > o.recap.l && o.add.t < o.recap.b && o.add.b > o.recap.t;
            if (cover(g)) failures.push(`${label}: at rest the footer's line covers Add member: ` + JSON.stringify(g));
            if (g.add && g.actions && g.add.t < g.actions.t && g.add.b > g.actions.t + 1) failures.push(`${label}: at rest Add member is cut by the footer (it is scrollable, but half of it is under the footer): ` + JSON.stringify(g));
            const clear = o => o.add && o.actions && o.add.b <= o.actions.t + 1 && o.hit;
            if (!clear(s)) failures.push(`${label}: scrolled to the very end, Add member is whole and clear of the footer: ${JSON.stringify({ s, g })}`);
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('team_step2_add_member_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
