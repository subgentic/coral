// The Analytics view Resource queue (#13671, the Operator's ask): how much the queue is used and whether it improves coordination. The read is stubbed (GET /api/analytics/resource-queue, numbers only).
// Pinned: the view is in the sidebar; four KPIs (overlap before and since, slot-request posts, the wait for a machine); the before/after table with the days of each side; a bar a day for the overlap and
// the go-live day marked; the resource table (claims, busy, waits, hook and hand claims, refused, kicked, lease ran out); holds by agent and by command as text; a refused or missing read says one line; the
// queue off says so; nothing is drawn as zero that is not known; a phone does not scroll sideways. Isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const today = new Date().toISOString().slice(0, 10);
const dayAgo = back => new Date(Date.parse(today + 'T00:00:00Z') - back * 86400000).toISOString().slice(0, 10);
// seven days ending today; the queue went live on the day two days ago (so six days before it ends... five before, two since in whole days)
const BODY = () => ({
    days_asked: 7, generated_at: new Date().toISOString(), go_live: dayAgo(2) + 'T16:00:00Z', queue: true, history: true, dropped: 0,
    resources: [{ resource: 'mac-heavy', slots: 1, claims: 23, busy_pct: 61, wait_median_s: 120, wait_p90_s: 660, at_once_pct: 40, auto: 19, hand: 4, refused: 3, kicked: 1, expired: 0 }, { resource: 'mini', slots: 1, claims: 4, busy_pct: 12.5, wait_median_s: 0, wait_p90_s: 30, at_once_pct: 100, auto: 0, hand: 4, refused: 0, kicked: 0, expired: 1 }],
    by_agent: [{ agent: 'Frontend Dev', holds: 9, hours: 4.5 }, { agent: 'QA Engineer', holds: 7, hours: 2 }, { agent: 'Backend Dev', holds: 1, hours: 0.25 }],
    by_pattern: [{ pattern: 'go test ./...', holds: 12 }, { pattern: 'npm run test:cloud', holds: 5 }],
    by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, by_resource: h >= 9 && h <= 17 ? { 'mac-heavy': 2, mini: h === 10 ? 1 : 0 } : {} })),
    per_day: Array.from({ length: 7 }, (_, i) => ({ day: dayAgo(6 - i), claims: i, by_resource: { 'mac-heavy': i, mini: i % 2 }, refused: 0, kicked: 0, expired: 0, overlap_mac_min: i < 4 ? 40 + i : 0, overlap_mini_min: i === 1 ? 10 : 0, slot_posts: i < 4 ? 12 - i : 2 })),
    before_after: { cut: dayAgo(2) + 'T16:00:00Z', before: { days: 4.67, overlap_min_per_day: 40, slot_posts_per_day: 12, wait_median_min: 14, wait_samples: 9, runs: 31 }, since: { days: 2, overlap_min_per_day: 5, slot_posts_per_day: 3, wait_median_min: 3, wait_samples: 11, runs: 12 } },
});

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push(true); console.log('PASS ' + name); } catch (e) { results.push(false); console.log('FAIL ' + name + ': ' + (e && e.message)); process.exitCode = 1; } };
    const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
    const refresh = () => ev(`[...document.querySelectorAll('#cost-resource-queue select')][0].dispatchEvent(new Event('change', { bubbles: true })); true`);
    const set = body => ev(`window.__rq.body = ${JSON.stringify(body)}; true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__reqs = []; window.__rq = { status: 200, body: ${JSON.stringify(BODY())} };
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname;
                const ok = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                if (p === '/api/analytics/resource-queue') { window.__reqs.push(p + url.search); return window.__rq.status === 200 ? ok(window.__rq.body) : ok({ error: 'no' }, window.__rq.status); }
                return R(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 5`, 'the list of views', 10000);
        const open = () => ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].find(b => /Resource queue/.test(b.textContent)).click(); true`);

        await run('the view is in the sidebar after Inbox vs chat, with its question', async () => {
            const names = await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].map(b => b.textContent.trim())`);
            assert.equal(names.indexOf('Resource queue'), names.indexOf('Inbox vs chat') + 1, JSON.stringify(names));
        });
        await open();
        await waitFor(`document.querySelectorAll('#cost-resource-queue .atab-kpi').length === 4 && document.querySelectorAll('#cost-resource-queue svg .atab-bar').length > 0`, 'the view drawn', 10000);

        await run('the request asks for the period and the four KPIs say overlap before and since, slot posts and the wait', async () => {
            assert.ok((await ev(`window.__reqs`)).some(r => /days=7/.test(r)), 'asked for 7 days');
            const k = await ev(`[...document.querySelectorAll('#cost-resource-queue .atab-kpi')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.match(k[0], /Overlapping heavy runs, before.*40 min a day/, JSON.stringify(k));
            assert.match(k[1], /since the queue.*5 min a day.*87% less than before/, JSON.stringify(k));
            assert.match(k[2], /Slot-request posts, since.*3 posts a day.*75% less than before/, JSON.stringify(k));
            assert.match(k[3], /Median wait for a slot, since.*3 min.*about 14 min \(an estimate\)/, JSON.stringify(k));
            assert.equal(await ev(`document.querySelectorAll('#cost-resource-queue .atab-kpi-d.atab-good').length`), 2, 'lower is shown as good');
        });
        await run('the four KPI cards and the panels sit inside the view at 1280 and at 390', async () => {
            const inside = () => ev(`(() => { const host = document.getElementById('cost-resource-queue').getBoundingClientRect(); const bad = [...document.querySelectorAll('#cost-resource-queue .atab-kpi, #cost-resource-queue .atab-card')].filter(e => { const r = e.getBoundingClientRect(); return r.right > host.right + 1 || r.left < host.left - 1; }).map(e => e.className + ' ' + Math.round(e.getBoundingClientRect().right) + '>' + Math.round(host.right)); return bad; })()`);
            assert.deepEqual(await inside(), [], 'at 1280');
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await refresh();
            await waitFor(`document.querySelectorAll('#cost-resource-queue .atab-kpi').length === 4`, 'the view on a phone', 10000);
            assert.deepEqual(await inside(), [], 'at 390');
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await refresh();
            await waitFor(`document.querySelectorAll('#cost-resource-queue .atab-kpi').length === 4`, 'back at 1280', 10000);
        });
        await run('the before/after table gives each side its days and its numbers, and says the before is an estimate', async () => {
            const t = await text('#cost-resource-queue .atab-card:has(table), #cost-resource-queue .atab-card');
            const all = await text('#cost-resource-queue');
            assert.match(all, /Before \(4\.67 days\)/); assert.match(all, /Since \(2 days\)/);
            assert.match(all, /Heavy runs overlapping on one computer\s*40 min a day\s*5 min a day/, all.slice(0, 600));
            assert.match(all, /Median wait for a slot\s*about 14 min\s*3 min/);
            assert.match(all, /they are estimates/);
            assert.equal(await ev(`[...document.querySelectorAll('#cost-resource-queue .atab-card')].find(c => /Before and after/.test(c.querySelector('h3').textContent)).querySelector('th, [role=columnheader]').textContent.trim()`), 'Measure', 'the first column is named');
            assert.equal(await ev(`document.querySelectorAll('#cost-resource-queue .atab-say[role=status]').length`), 0, 'the explanations are not live regions');
            assert.match(all, new RegExp('went live ' + dayAgo(2) + ' 16:00'), 'the date comes from the read');
            assert.ok(t.length > 0);
        });
        await run('a bar a day for the overlap, the go-live day marked, in words as well as bars', async () => {
            const bars = await ev(`new Set([...document.querySelectorAll('#cost-resource-queue .atab-card')].find(c => /Heavy runs overlapping/.test(c.querySelector('h3').textContent)).querySelectorAll('svg .atab-bar')).size`);
            assert.ok(bars >= 1, 'bars drawn');
            const svgText = await ev(`[...document.querySelectorAll('#cost-resource-queue svg text')].map(t => t.textContent).join(' ')`);
            assert.match(svgText, /queue live/, 'the go-live day is named on the axis');
        });
        await run('claims over time: per day and by hour of the day, by resource', async () => {
            const cards = await ev(`[...document.querySelectorAll('#cost-resource-queue .atab-card')].map(c => c.querySelector('h3').textContent.trim())`);
            assert.ok(cards.some(c => /^Claims per dayslots granted, by resource/.test(c)), JSON.stringify(cards));
            assert.ok(cards.some(c => /^Claims by hour of the day/.test(c)), JSON.stringify(cards));
            const bars = await ev(`(() => { const card = t => [...document.querySelectorAll('#cost-resource-queue .atab-card')].find(c => c.querySelector('h3').textContent.startsWith(t)); return { day: new Set([...card('Claims per day').querySelectorAll('svg .atab-bar')].map(b => b.getAttribute('x'))).size, hour: new Set([...card('Claims by hour').querySelectorAll('svg .atab-bar')].map(b => b.getAttribute('x'))).size, legend: [...card('Claims per day').querySelectorAll('.atab-legend li')].map(l => l.textContent) }; })()`);
            assert.ok(bars.day >= 6, 'a bar for each day with a claim: ' + JSON.stringify(bars)); assert.ok(bars.hour >= 9, 'a bar for each hour with a claim: ' + JSON.stringify(bars));
            assert.deepEqual(bars.legend, ['mac-heavy', 'mini'], 'each resource is named');
        });
        await run('the resource table, the holds by agent and by command', async () => {
            const all = await text('#cost-resource-queue');
            assert.match(all, /mac-heavy\s*23\s*61%\s*2 min \/ 11 min · 40% at once\s*19 \/ 4\s*3 \/ 1 \/ 0/, all.slice(all.indexOf('Use of each'), all.indexOf('Use of each') + 400));
            assert.match(all, /mini\s*4\s*12\.5%\s*0 s \/ 30 s · 100% at once\s*0 \/ 4\s*0 \/ 0 \/ 1/);
            const cols = await ev(`(() => { const c = [...document.querySelectorAll('#cost-resource-queue .atab-card')].find(c => /Use of each resource/.test(c.querySelector('h3').textContent)); const hidden = /\\d+ columns? hidden/.test(c.textContent); const heads = [...c.querySelectorAll('th, [role=columnheader]')].filter(h => h.getClientRects().length).map(h => h.textContent.trim().toLowerCase()); return { hidden, heads }; })()`);
            assert.equal(cols.hidden, false, 'the resource table hides no column at 1280 (the singular "1 column hidden" too): ' + JSON.stringify(cols));
            for (const w of ['claims', 'busy', 'wait: median', 'by the hook', 'refused / kicked / lease ran out']) assert.ok(cols.heads.some(h => h.includes(w)), 'column visible: ' + w + ' in ' + JSON.stringify(cols.heads));
            assert.match(all, /Frontend Dev\s*9 holds · 4\.5 h/); assert.match(all, /go test \.\/\.\.\.\s*12 holds/);
            assert.match(all, /never the command itself/);
        });
        await run('before the queue went live there is no since to compare, said plainly', async () => {
            const b = BODY(); b.before_after.since = { days: 0, overlap_min_per_day: 0, slot_posts_per_day: 0, wait_median_min: -1, wait_samples: 0, runs: 0 };
            await set(b); await refresh();
            await waitFor(`/Not yet/.test(document.getElementById('cost-resource-queue').textContent)`, 'Not yet', 8000);
            const k = await ev(`[...document.querySelectorAll('#cost-resource-queue .atab-kpi')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.match(k[1], /Not yet/); assert.ok(!/% less than before/.test(k[1]), 'no change is claimed with nothing since');
            await set(BODY()); await refresh();
            await waitFor(`/5 min a day/.test(document.getElementById('cost-resource-queue').textContent)`, 'back', 8000);
        });
        await run('a refused or missing read says one line, and the queue off or unrecorded says so', async () => {
            for (const code of [403, 404]) {
                await ev(`window.__rq.status = ${code}; true`); await refresh();
                await waitFor(`/for the person at this computer only/.test(document.getElementById('cost-resource-queue').textContent)`, `the refusal line for ${code}`, 8000);
            }
            await ev(`window.__rq.status = 200; true`);
            const off = BODY(); off.queue = false; off.history = false; off.resources = [];
            await set(off); await refresh();
            await waitFor(`/resource queue is off on this computer/.test(document.getElementById('cost-resource-queue').textContent)`, 'queue off', 8000);
            const kOff = await ev(`[...document.querySelectorAll('#cost-resource-queue .atab-kpi')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.match(kOff[3], /Median wait for a slot, since\s*Unavailable/, JSON.stringify(kOff)); assert.ok(!/No samples|no samples/.test(kOff[3]), 'unavailable is not "no samples"');
            assert.match(await text('#cost-resource-queue'), /Median wait for a slot\s*about 14 min\s*Unavailable/, 'the table row says unavailable, not 0 or no samples');
            const nohist = BODY(); nohist.history = false;
            await set(nohist); await refresh();
            await waitFor(`/could not be opened on this computer/.test(document.getElementById('cost-resource-queue').textContent)`, 'no history', 8000);
            assert.match(await text('#cost-resource-queue'), /Median wait for a slot\s*about 14 min\s*Unavailable/, 'no record: unavailable');
            await set(BODY()); await refresh();
            await waitFor(`document.querySelectorAll('#cost-resource-queue .atab-kpi').length === 4 && /Holds by agent/.test(document.getElementById('cost-resource-queue').textContent)`, 'back', 8000);
        });
        await run('a phone does not scroll sideways, and the numbers are still all there as text', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await refresh();
            await waitFor(`document.querySelectorAll('#cost-resource-queue .atab-kpi').length === 4`, 'the view on a phone', 10000);
            assert.ok(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no sideways scroll of the page');
            const all = await text('#cost-resource-queue');
            for (const w of ['40 min a day', '5 min a day', 'mac-heavy', 'Frontend Dev', 'Holds by command']) assert.ok(all.includes(w), w);
            if (process.env.RQ_SHOTS) for (const [w, h, mob] of [[1280, 1000, false], [390, 844, true]]) for (const theme of ['light', 'dark']) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: mob ? 3600 : 2600, deviceScaleFactor: 1, mobile: mob }); // tall: the view scrolls inside its own box, so the shot shows all of it
                await refresh(); if (mob) await open();
                await waitFor(`document.querySelectorAll('#cost-resource-queue .atab-kpi').length === 4`, 'drawn', 10000);
                await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); window.scrollTo(0, 0); true`);
                await new Promise(r => setTimeout(r, 700)); // sleep-ok: the repaint
                const clip = await ev(`(() => { const r = document.getElementById('cost-resource-queue').getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 8), width: innerWidth, height: Math.min(r.height + 16, innerHeight - Math.max(0, r.top - 8)), scale: 1 }; })()`);
                require('node:fs').writeFileSync(`${process.env.RQ_SHOTS}-${w}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png', clip })).data, 'base64'));
            }
        });
    } finally { await client.close(); }
    if (results.some(r => !r)) process.exitCode = 1; else console.log('PASS resource queue analytics: the view, the before/after, the bars, the tables, the off states, a phone');
})().catch(e => { console.error(e); process.exitCode = 1; });
