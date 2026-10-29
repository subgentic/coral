// The New job dialog does not cut the When row at its scroll edge (#9965, Beta Tester pass 3 point 4): when it opens, the When (schedule) row, the heart of a job, is whole and in view (a tall field such as the Prompt
// may run on below the edge: that is scrolling, a half-drawn schedule was the complaint). Agent prompt type, 820 px high and a 600 px high window, 1280 px wide. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 820], [1280, 700]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('job-modal-name') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, 'the New job dialog', 8000);
            await ev(`(() => { const b = [...document.querySelectorAll('#job-type-toggle button')].find(x => x.dataset.type === 'prompt'); if (b) b.click(); return true; })()`);
            await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: the dialog settles on its type
            const g = await ev(`(() => {
                const form = document.getElementById('job-form');
                let box = form; while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
                const edge = (box && box !== document.body ? box : form).getBoundingClientRect();
                const rows = [...form.querySelectorAll('.sv-row, .sv-field, [data-field]')].filter(e => e.getClientRects().length && e.getBoundingClientRect().height > 8);
                const cut = rows.filter(e => { const r = e.getBoundingClientRect(); return r.top < edge.bottom - 1 && r.bottom > edge.bottom + 1; }).map(e => (e.id || e.className).toString().slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().top) + '-' + Math.round(e.getBoundingClientRect().bottom) + ' edge ' + Math.round(edge.bottom));
                const when = document.getElementById('sched-picker') || document.querySelector('.sched-presets');
                const wr = when && when.getBoundingClientRect();
                return { cut, whenInView: !!wr && wr.top >= edge.top - 1 && wr.bottom <= edge.bottom + 1, scrolls: !!box && box !== document.body, edge: Math.round(edge.bottom), when: wr ? Math.round(wr.top) + '-' + Math.round(wr.bottom) : null };
            })()`);
            assert.ok(g.whenInView && !g.cut.some(c => /sv-row-custom|sched/.test(c)), `${h}px high: the When row is whole and in view ${JSON.stringify(g)}`);
            console.log(`PASS ${w}x${h}: the When row is whole and in view ${JSON.stringify(g)}`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
