// The Cumulative spend chart is one series on one scale that fills its card (#7712): the line, its area and the axis share one x scale; nothing is drawn past the last point (the per-bucket bars took the page's .spend-bar rule,
// "width: 100%", and ran to the right edge as stacked bands); a live refresh redraws the chart instead of adding to it; and the plot follows the card's width when the window changes (it was drawn at the width measured once, and
// the svg then sat centred in a wider card, with an empty band on the left). Desktop at three widths and a 390 px phone, with the census data world.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const probe = () => ev(`(() => {
        const svg = document.querySelector('#cost-spend-chart svg'), box = document.getElementById('cost-spend-chart');
        if (!svg) return null;
        const cs = getComputedStyle(box), inner = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
        const dot = svg.querySelector('circle'), dotX = dot ? +dot.getAttribute('cx') : 0;
        const past = [...svg.querySelectorAll('polygon, polyline, rect, circle')].map(e => e.getBBox()).filter(b => b.x + b.width > dotX + 3.5).length; // the dot's own radius is 3
        const labels = [...svg.querySelectorAll('text')].map(t => t.getBBox());
        return { areas: svg.querySelectorAll('polygon').length, lines: svg.querySelectorAll('polyline').length, rects: svg.querySelectorAll('rect').length, past, svgW: Math.round(r.width), vbW: Math.round(vb.width), inner: Math.round(inner),
            minLabelX: Math.round(Math.min(...labels.map(b => b.x))), dotX: Math.round(dotX), plotLeft: +svg.querySelector('line').getAttribute('x1'), plotRight: +svg.querySelector('line').getAttribute('x2') };
    })()`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await ev(`document.getElementById('cost-spend-chart').scrollIntoView({ block: 'center' }); new Promise(r => setTimeout(r, 350))`); /* sleep-ok: a screenshot waits out scrolling */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`!!document.querySelector('#cost-spend-chart svg polygon')`, 'the spend chart');
        const fits = (p, tag) => {
            assert.equal(p.areas, 1, `${tag}: one area ${JSON.stringify(p)}`);
            assert.equal(p.lines, 1, `${tag}: one line ${JSON.stringify(p)}`);
            assert.equal(p.rects, 0, `${tag}: no bars or other rectangles ${JSON.stringify(p)}`);
            assert.equal(p.past, 0, `${tag}: nothing is drawn past the last point ${JSON.stringify(p)}`);
            assert.ok(Math.abs(p.svgW - p.vbW) <= 1 && Math.abs(p.svgW - p.inner) <= 1, `${tag}: the chart is drawn at the card's width, one scale (svg ${p.svgW}, viewBox ${p.vbW}, card ${p.inner})`);
            assert.ok(Math.abs(p.plotRight - p.dotX) <= 1, `${tag}: the line ends where the plot does ${JSON.stringify(p)}`);
        };
        // the page settles as its tables arrive (the card can change by a few px): the chart is drawn again at the card's width, which is what is asserted, not the frame before it
        await waitFor(`(() => { const s = document.querySelector('#cost-spend-chart svg'), b = document.getElementById('cost-spend-chart'); const c = getComputedStyle(b); return !!s && Math.abs(Math.round(s.viewBox.baseVal.width) - Math.round(b.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight))) <= 1; })()`, 'the chart at the card\'s width', 6000);
        fits(await probe(), 'desktop');
        const ends = await ev(`({ tile: document.getElementById('cost-total-cost').textContent.trim(), top: document.querySelector('#cost-spend-chart text.spend-label').textContent.trim() })`);
        assert.equal(ends.top, ends.tile, 'the axis top and the line\'s end are the Total cost tile\'s figure (#7719) ' + JSON.stringify(ends));
        await shot('cumulative-spend-desktop');
        // a live refresh draws it again: still one of everything
        for (let i = 0; i < 2; i++) { await ev(`document.querySelector('[data-on-click="cost-refresh"]').click(); true`); await ev(`new Promise(r => setTimeout(r, 400))`); } // sleep-ok: the refresh reads and redraws
        fits(await probe(), 'after two refreshes');
        // the window changes: the plot follows the card
        for (const w of [900, 1600, 390]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: w < 500 });
            if (w < 500) await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.selectView('overview'); return true; })`); // a phone shows the list first: the Overview is the screen after it
            await waitFor(`(() => { const s = document.querySelector('#cost-spend-chart svg'), b = document.getElementById('cost-spend-chart'); const c = getComputedStyle(b); return !!s && Math.abs(Math.round(s.viewBox.baseVal.width) - Math.round(b.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight))) <= 1 && b.getClientRects().length > 0; })()`, `the chart drawn at the card's width at ${w} px`);
            fits(await probe(), `${w} px`);
            if (w === 390) await shot('cumulative-spend-phone');
        }
        // drawn while its view is hidden (the page is not Overview: the card has no width, the chart takes its 600 px fallback), then shown: it is drawn again at the card's width, not left at 600 (#7719 item 2)
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const loaded = Page.loadEventFired(); await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await loaded; await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.switchNavTab('tokens'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.selectView('model'); return true; })`); // a phone opens on Overview now (#10064): another page hides the card while its chart is drawn
        await waitFor(`!!document.querySelector('#cost-spend-chart svg polygon')`, 'the spend chart');
        await ev(`document.querySelector('[data-on-click="cost-refresh"]').click(); true`); // the read answers with the card hidden: the chart is drawn again without a width
        await waitFor(`Math.round(document.querySelector('#cost-spend-chart svg').viewBox.baseVal.width) === 600`, 'the spend chart, drawn while hidden', 6000);
        const hidden = await ev(`({ shown: document.getElementById('cost-spend-chart').getClientRects().length > 0, vb: Math.round(document.querySelector('#cost-spend-chart svg').viewBox.baseVal.width) })`);
        assert.equal(hidden.shown, false, 'another Analytics page is open: the chart is hidden ' + JSON.stringify(hidden));
        assert.equal(hidden.vb, 600, 'drawn hidden, it has the 600 px fallback ' + JSON.stringify(hidden));
        await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.selectView('overview'); return true; })`);
        await waitFor(`(() => { const s = document.querySelector('#cost-spend-chart svg'), b = document.getElementById('cost-spend-chart'); const c = getComputedStyle(b); return b.getClientRects().length > 0 && Math.abs(Math.round(s.viewBox.baseVal.width) - Math.round(b.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight))) <= 1; })()`, 'the chart drawn again at the card\'s width once shown');
        fits(await probe(), 'phone, drawn hidden then shown');
        console.log('PASS Cumulative spend: one series on one scale, nothing past the last point, redrawn not added to, fits the card at every width');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
