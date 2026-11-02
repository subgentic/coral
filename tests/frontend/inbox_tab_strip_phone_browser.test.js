// The phone's Inbox tab strip (#12401, Mobile Beta Tester): with Goals open, the strip no longer scrolls Needs you to its red count alone. The open tab is brought into view, and when the first tab (Needs you) and the
// open one fit together the first keeps its label in view too. At 390 px, by a click on the tab and by the address.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const strip = () => ev(`(() => { const nav = document.querySelector('.view-list-nav'); if (!nav) return null; const n = nav.getBoundingClientRect(); const tabs = [...nav.querySelectorAll('.view-list-item')]; const box = t => { const r = t.getBoundingClientRect(); return { l: Math.round(r.left - n.left), r: Math.round(r.right - n.left) }; };
        const find = w => tabs.find(t => new RegExp(w).test(t.textContent)); const needs = find('Needs you'), goals = find('Goals'); return { w: Math.round(n.width), scroll: Math.round(nav.scrollLeft), needs: needs && box(needs), goals: goals && box(goals), cur: (nav.querySelector('[aria-current="true"]') || {}).textContent || '' }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        for (const how of ['click', 'address']) {
            await Page.navigate({ url: BASE + (how === 'click' ? '/inbox/needs' : '/inbox/goals') }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await waitFor(`!!document.querySelector('.view-list-nav .view-list-item[aria-current="true"]')`, how + ': the strip', 10000);
            if (how === 'click') { await ev(`[...document.querySelectorAll('.view-list-nav .view-list-item')].find(t => /Goals/.test(t.textContent)).click(); true`); await waitFor(`/Goals/.test((document.querySelector('.view-list-nav [aria-current="true"]') || {}).textContent || '')`, 'Goals open', 8000); }
            await new Promise(r => setTimeout(r, 700)); // sleep-ok: the strip scrolls the open tab into view over a few frames
            const m = await strip();
            check(m && /Goals/.test(m.cur), how + ': Goals is the open tab: ' + JSON.stringify(m));
            check(m && m.needs.l >= 0 && m.needs.r <= m.w, how + ': Needs you shows whole, its label and its count: ' + JSON.stringify(m));
            check(m && m.goals.l >= 0 && m.goals.r <= m.w + 2, how + ': the open Goals tab shows whole: ' + JSON.stringify(m));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exitCode = 1; } else console.log('PASS the phone Inbox strip keeps Needs you and the open tab in view');
})().catch(e => { console.error(e); process.exitCode = 1; });
