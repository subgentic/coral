// Analytics: Tokens per commit and Task time have a Group by switch (Goal #77, the Operator's approved mock). All is the section's own view; Model, Thinking level and the rest are the comparison across teams: cards, ranked
// bars with the average line, a table; a group under 10 commits or tasks is hatched and tagged "few". GET /api/analytics/efficiency is stubbed. 1280 (the segmented switch) and 390 (one select), light and dark shots,
// no sideways scroll. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const TPC = { metric: 'tokens_per_commit', range: '24h', min_sample: 10, total: { n: 171 }, average: { value: 304000, usual: 301000 }, unmeasured: ['gemini'], groups: [
    { key: 'sonnet', label: 'claude-sonnet-5-5', provider: 'claude', value: 268000, n: 61, tokens: 16300000, cost_usd_per_unit: 2.2 }, { key: 'opus', label: 'claude-opus-5-5', provider: 'claude', value: 412000, n: 38, tokens: 15700000, cost_usd_per_unit: 6.8 },
    { key: 'haiku', label: 'claude-haiku-5-5', provider: 'claude', value: 141000, n: 12, tokens: 1700000, cost_usd_per_unit: 0.6 }, { key: 'codex', label: 'gpt-5.5-codex', provider: 'codex', value: 305000, n: 47, tokens: 14300000, cost_usd_per_unit: 2.4 },
    { key: 'agy', label: 'agy default', provider: 'agy', value: 352000, n: 9, tokens: 3200000, cost_usd_per_unit: 2.7 }, { key: 'pi', label: 'pi: qwen3-coder', provider: 'pi', value: 190000, n: 4, tokens: 800000, cost_usd_per_unit: 0.9 }] };
const TT = { metric: 'task_time', range: '24h', min_sample: 10, total: { n: 260 }, average: { value: 1080 }, groups: [
    { key: 'low', label: 'Low', value: 540, n: 57, sent_back_share: 0.29, cost_usd_per_unit: 1.4 }, { key: 'medium', label: 'Medium', value: 900, n: 88, sent_back_share: 0.17, cost_usd_per_unit: 2.6 },
    { key: 'high', label: 'High', value: 1440, n: 64, sent_back_share: 0.12, cost_usd_per_unit: 5.3 }, { key: 'max', label: 'Max', value: 2460, n: 5, sent_back_share: 0.1, cost_usd_per_unit: 9 }] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String(e.message).slice(0, 400)); } };
    const shot = async (name, theme) => { const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return; await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the theme repaints
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.includes('coral-eff-group')) localStorage.removeItem(k); } catch {} true`); // the 1280 pass's choice (Model) is remembered: the 390 pass starts at All
            await ev(`(() => { window.__effReads = []; const R = window.fetch.bind(window);
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (url.pathname === '/api/analytics/efficiency') { window.__effReads.push(url.search); const m = url.searchParams.get('metric'); return Promise.resolve(new Response(JSON.stringify(m === 'task_time' ? ${JSON.stringify(TT)} : ${JSON.stringify(TPC)}), { status: 200, headers: { 'content-type': 'application/json' } })); }
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`!!document.querySelector('#cost-nav-list .row-btn[data-view="per-commit"]') || !!document.querySelector('#cost-dashboard-view')`, `${label}: the Analytics page`, 10000);
            const open = view => ev(`(() => { const b = document.querySelector('#cost-nav-list .row-btn[data-view="${view}"]'); if (b) b.click(); return !!b; })()`);
            await run(`${label}: Tokens per commit has a Group by switch, All first and shown`, async () => {
                await open('per-commit');
                await waitFor(`!!document.querySelector('#cost-spend-section .eff-switch')`, 'the switch', 8000);
                const s = await ev(`(() => { const sec = document.getElementById('cost-spend-section'); const btns = [...sec.querySelectorAll('.eff-seg-btn')]; return { labels: btns.map(b => b.textContent), on: (btns.find(b => b.getAttribute('aria-pressed') === 'true') || {}).textContent, seg: getComputedStyle(sec.querySelector('.eff-seg')).display, pick: getComputedStyle(sec.querySelector('.eff-pick')).display }; })()`);
                assert.deepEqual(s.labels, ['All', 'Provider', 'Model', 'Thinking level', 'Team', 'Agent', 'Branch', 'Task']); assert.equal(s.on, 'Model'); // the metric starts grouped by Model (#9236)
                assert.equal(mobile ? s.seg : s.pick, 'none', mobile ? 'a phone has the select, not the buttons' : 'a desktop has the buttons, not the select'); assert.notEqual(mobile ? s.pick : s.seg, 'none');
            });
            await run(`${label}: grouped by Model: the cards, the bars with the average line, the table, few tagged and hatched`, async () => {
                await open('per-commit'); await waitFor(`!document.getElementById('cost-spend-section').hidden`, 'Tokens per commit on screen', 8000); // a slow page (CPU x6) finishes opening Analytics on Overview after the click of the step before: the view is asked for again
                if (mobile) await ev(`(() => { const s = document.querySelector('#cost-spend-section .eff-pick'); s.value = 'model'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                else await ev(`[...document.querySelectorAll('#cost-spend-section .eff-seg-btn')].find(b => b.textContent === 'Model').click(); true`);
                await waitFor(`document.querySelectorAll('#cost-eff-per-commit .eff-bar').length === 6`, 'the six bars', 8000);
                const m = await ev(`(() => { const v = document.getElementById('cost-eff-per-commit'); return { text: v.textContent.replace(/\\s+/g, ' '), few: v.querySelectorAll('.eff-fill.eff-few').length, avg: v.querySelectorAll('.eff-avg').length, rows: v.querySelectorAll('tbody tr').length, old: document.getElementById('cost-spend').hidden, over: document.documentElement.scrollWidth - innerWidth, reads: window.__effReads }; })()`);
                assert.match(m.text, /Most efficient \(at least 10 commits\)claude-haiku-5-5/); assert.match(m.text, /Average, all commits304 K/); assert.match(m.text, /2 groups below 10 commits, shown but not ranked/);
                assert.equal(m.few, 2); assert.equal(m.avg, 6); assert.equal(m.rows, 6); assert.equal(m.old, true); assert.ok(m.over <= 1, 'no sideways scroll: ' + m.over);
                assert.match(m.reads[0], /metric=tokens_per_commit&group_by=model&range=24h/);
                await shot(`analytics-efficiency-commit-model-${label}-light`, 'light'); await shot(`analytics-efficiency-commit-model-${label}-dark`, 'dark');
            });
            await run(`${label}: Task time grouped by Thinking level: fastest, cheapest, sent back`, async () => {
                await open('task-time');
                await waitFor(`!!document.querySelector('#cost-task-time-section .eff-switch')`, 'the switch', 8000);
                if (mobile) await ev(`(() => { const s = document.querySelector('#cost-task-time-section .eff-pick'); s.value = 'thinking'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                else await ev(`[...document.querySelectorAll('#cost-task-time-section .eff-seg-btn')].find(b => b.textContent === 'Thinking level').click(); true`);
                await waitFor(`document.querySelectorAll('#cost-eff-task-time .eff-bar').length === 4`, 'the four bars', 8000);
                const t = await ev(`document.getElementById('cost-eff-task-time').textContent.replace(/\\s+/g, ' ')`);
                assert.match(t, /Fastest \(at least 10 tasks\)Low/); assert.match(t, /Cheapest per taskLow\$1\.40 per task/); assert.match(t, /Max5 tasks · 10% sent back · too few to rank/);
                await shot(`analytics-efficiency-time-thinking-${label}-light`, 'light'); await shot(`analytics-efficiency-time-thinking-${label}-dark`, 'dark');
            });
            await run(`${label}: All puts the section's own view back`, async () => {
                if (mobile) await ev(`(() => { const s = document.querySelector('#cost-task-time-section .eff-pick'); s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                else await ev(`[...document.querySelectorAll('#cost-task-time-section .eff-seg-btn')].find(b => b.textContent === 'All').click(); true`);
                assert.equal(await ev(`document.getElementById('cost-task-time').hidden`), false); assert.equal(await ev(`document.getElementById('cost-eff-task-time').hidden`), true);
            });
        }
    } finally { await client.close(); }
    const failed = results.filter(([, e]) => e);
    if (failed.length) { console.error(`${failed.length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Analytics efficiency checks passed`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
