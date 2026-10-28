// The dashboard's page weight at start (#9750, Data Science #9731: 553 KB over 32 requests): what a first visit loads before anything is opened, measured on the isolated dev server in headless Chrome with the
// Resource Timing entries (requests, encoded bytes, the bundle's two big files). It is a ceiling, not an exact number: the baseline in fixtures/page_weight_baseline.json plus 2 percent of room, so an
// unrelated startup change of a few hundred bytes does not fail it, and a module added to the startup graph does. A move to a lazy import lowers the numbers: run with CORAL_UPDATE_WEIGHT=1 to write the new
// baseline (it only goes down by itself: a run that is bigger than the baseline plus its room fails). First paint is printed, never asserted (it is time, and the Mac is loaded).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const BASELINE = path.join(__dirname, 'fixtures', 'page_weight_baseline.json');
const ROOM = 1.02;

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`document.readyState === 'complete' && typeof window.switchNavTab === 'function'`, 'the dashboard started', 15000);
        // the start has settled when the request count has not moved for half a second
        await waitFor(`(() => { const n = performance.getEntriesByType('resource').length; const s = window.__wsettle || (window.__wsettle = { n, at: Date.now() }); if (s.n !== n) { s.n = n; s.at = Date.now(); } return Date.now() - s.at > 600; })()`, 'the start settled', 15000);
        const m = JSON.parse(await ev(`JSON.stringify((() => { const res = performance.getEntriesByType('resource'); const sum = f => res.filter(f).reduce((n, e) => n + e.encodedBodySize, 0), name = e => e.name.replace(location.origin, '');
            return { requests: res.length, encoded: res.reduce((n, e) => n + e.encodedBodySize, 0), appJs: sum(e => /\\/app\\.js$/.test(e.name)), css: sum(e => /\\.css$/.test(e.name)), scripts: res.filter(e => e.initiatorType === 'script' && /\\.js$/.test(e.name)).length,
                fcp: Math.round((performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint') || {}).startTime || 0) }; })())`));
        const now = { requests: m.requests, encoded: m.encoded, appJs: m.appJs, css: m.css, scripts: m.scripts };
        console.log('page weight at start: ' + JSON.stringify(m));
        if (process.env.CORAL_UPDATE_WEIGHT) { fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n'); console.log('baseline written: ' + JSON.stringify(now)); return; }
        const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
        for (const k of Object.keys(base)) assert.ok(now[k] <= Math.ceil(base[k] * ROOM), `${k} at start is ${now[k]}, over the baseline ${base[k]} plus 2 percent (CORAL_UPDATE_WEIGHT=1 writes a new baseline when the weight is meant to change): ${JSON.stringify(now)}`);
        const lower = Object.keys(base).filter(k => now[k] < base[k] * 0.9);
        if (lower.length) console.log('   (below the baseline by more than 10 percent: ' + lower.map(k => `${k} ${now[k]} < ${base[k]}`).join(', ') + '; lower it with CORAL_UPDATE_WEIGHT=1)');
        console.log('PASS the start weighs no more than its baseline');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
