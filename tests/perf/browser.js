#!/usr/bin/env node
// Dashboard load and screen-switch baseline for the Goal #85 measure (#9086): drives a headless Chrome over CDP against a SEEDED isolated Coral server (start it with --strict-local-auth=false,
// as run_cdp_suites does) and, for each screen, reports the median and worst of RUNS runs of: wall ms from the trigger to a settled page (no request in flight for 600 ms, then two frames), the main
// thread's task / script / layout / style ms, the long tasks (over 50 ms), and the requests it made (count, bytes, the slowest). It measures; it asserts nothing.
//
//   CORAL_TEST_URL=http://127.0.0.1:PORT CDP_PORT=9333 TARGETS=targets.json RUNS=5 OUT=browser.json node browser.js
//
// A "load" is a full navigation to the path; a "switch" is the app's own route change from the screen before (history.pushState + popstate, what a click on a link does). Needs chrome-remote-interface
// (tests/frontend/node_modules). It refuses port 8420 as test_base does.
const fs = require('node:fs');
const path = require('node:path');
const CDP = require(process.env.CRI || path.join(__dirname, '..', 'frontend', 'node_modules', 'chrome-remote-interface'));
const BASE = require(path.join(__dirname, '..', 'frontend', 'test_base')).BASE;

const RUNS = Number(process.env.RUNS || 5);
const T = JSON.parse(fs.readFileSync(process.env.TARGETS, 'utf8'));
const THROTTLE = Number(process.env.PERF_THROTTLE || 1);
const board = encodeURIComponent(T.board_id);
const agent = T.session_ids[0];
const SCREENS = [
    ['load: first load (/agents)', '/agents', 'load'],
    ['load: /inbox/needs', '/inbox/needs', 'load'],
    ['switch: Inbox Needs you', '/inbox/needs', 'switch'],
    ['switch: Inbox Saved', '/inbox/saved', 'switch'],
    ['switch: Inbox Artifacts', '/inbox/artifacts', 'switch'],
    ['switch: Inbox Chats (all)', '/inbox/chats/all', 'switch'],
    ['switch: Team Goals', `/team/${board}/goals`, 'switch'],
    ['switch: Team Agents', `/team/${board}/agents`, 'switch'],
    ['switch: Team Tasks', `/team/${board}/tasks`, 'switch'],
    ['switch: Team Artifacts', `/team/${board}/artifacts`, 'switch'],
    ['switch: Team Knowledge', `/team/${board}/knowledge`, 'switch'],
    ['switch: Team Board (messages)', `/team/${board}/board`, 'switch'],
    ['switch: Agent page', `/agents/${agent}`, 'switch'],
    ['switch: Agent page, Tasks tab', `/agents/${agent}/tasks`, 'switch'],
    ['switch: Agent page, Board tab', `/agents/${agent}/board`, 'switch'],
    ['switch: Analytics Overview', '/analytics', 'switch'],
    ['switch: Analytics By provider', '/analytics/provider', 'switch'],
    ['switch: Analytics By agent', '/analytics/agent', 'switch'],
    ['switch: Analytics Per commit', '/analytics/per-commit', 'switch'],
    ['switch: Analytics Task time', '/analytics/task-time', 'switch'],
    ['load: /team/<big>/tasks', `/team/${board}/tasks`, 'load'],
    ['load: /analytics', '/analytics', 'load'],
];
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(((s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2) * 10) / 10; };

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9333) });
    const { Page, Network, Performance, Emulation, Runtime } = client;
    await Page.enable(); await Network.enable(); await Performance.enable();
    await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    if (THROTTLE > 1) await Emulation.setCPUThrottlingRate({ rate: THROTTLE });
    const ev = async expr => { const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const metrics = async () => Object.fromEntries((await Performance.getMetrics()).metrics.map(m => [m.name, m.value]));

    // network accounting for the run in progress
    let inflight = new Map(), reqs = [], last = Date.now();
    Network.requestWillBeSent(e => { if (!/^https?:/.test(e.request.url)) return; inflight.set(e.requestId, { url: e.request.url, t0: e.timestamp, bytes: 0, at: Date.now() }); last = Date.now(); });
    Network.loadingFinished(e => { const r = inflight.get(e.requestId); if (r) { r.ms = (e.timestamp - r.t0) * 1000; r.bytes = e.encodedDataLength; reqs.push(r); inflight.delete(e.requestId); last = Date.now(); } });
    Network.loadingFailed(e => { inflight.delete(e.requestId); last = Date.now(); });
    // settled: no request in flight for 600 ms, then two frames. A request still open after 8 s is a stream or a long poll (the live feed), not part of the page's work: it is not waited for (a first baseline run
    // waited the full 60 s on every load for one of them).
    const abandoned = () => [...inflight.values()].filter(r => Date.now() - r.at >= 8000).map(r => ({ url: new URL(r.url).pathname + new URL(r.url).search, ageMs: Date.now() - r.at }));
    const open = () => [...inflight.values()].filter(r => Date.now() - r.at < 8000).length;
    const settled = async (timeoutMs = 30000) => {
        const until = Date.now() + timeoutMs;
        for (;;) { await sleep(50); if (open() === 0 && Date.now() - last > 600) break; if (Date.now() > until) return false; }
        await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        return true;
    };
    const LONG = `(() => { window.__long = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {} })()`;
    await Page.addScriptToEvaluateOnNewDocument({ source: LONG });

    const out = { base: BASE, runs: RUNS, throttle: THROTTLE, board: T.board_id, screens: [] };
    // one first visit so the server's own caches and Chrome's http cache are in the state of a second visit (a "load" below is a cached-assets load: the numbers are the app's, not the first download's)
    await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await settled();
    for (const [name, p, kind] of SCREENS) {
        const rows = [];
        for (let i = 0; i < RUNS; i++) {
            if (kind === 'switch') { // start each switch from another screen of the app, so it is a change of route
                await ev(`history.pushState({}, '', '/agents'); window.dispatchEvent(new PopStateEvent('popstate')); true`); await settled();
            }
            reqs = []; inflight = new Map(); last = Date.now();
            await ev(`window.__long = window.__long || []; window.__long.length = 0; true`).catch(() => {});
            const m0 = await metrics(); const t0 = Date.now();
            if (kind === 'load') { await Page.navigate({ url: BASE + p }); await Page.loadEventFired(); }
            else { // the router's own event says the screen is shown (a first run measured the 600 ms quiet window of an idle page: the detector saw nothing in flight before the request started)
                await ev(`window.__routed = new Promise(res => document.addEventListener('coral:route-changed', () => res(true), { once: true })); history.pushState({}, '', ${JSON.stringify(p)}); window.dispatchEvent(new PopStateEvent('popstate')); true`);
                await ev(`Promise.race([window.__routed, new Promise(res => setTimeout(() => res(false), 30000))])`);
            }
            const ok = await settled();
            const wall = Date.now() - t0 - 600 - 100; // the 600 ms quiet window and two frames are the detector's, not the page's
            const m1 = await metrics();
            const long = await ev(`(window.__long || []).slice()`).catch(() => []);
            const slow = [...reqs].sort((a, b) => b.ms - a.ms)[0];
            const ab = abandoned(); // requests still open after 8 s when the screen settled: streams, or the slowest request of the screen, which a finished-request list never shows
            rows.push({ ok, wall: Math.max(0, wall), task: (m1.TaskDuration - m0.TaskDuration) * 1000, script: (m1.ScriptDuration - m0.ScriptDuration) * 1000, layout: (m1.LayoutDuration - m0.LayoutDuration) * 1000,
                style: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000, longTasks: long.length, longMs: long.reduce((s, x) => s + x, 0), requests: reqs.length, bytes: reqs.reduce((s, r) => s + r.bytes, 0),
                slowest: slow ? `${Math.round(slow.ms)}ms ${new URL(slow.url).pathname}${new URL(slow.url).search}`.slice(0, 120) : '', apis: [...new Set(reqs.filter(r => /\/api\//.test(r.url)).map(r => new URL(r.url).pathname))].length, abandoned: ab });
        }
        const s = { name, path: p, kind, wallMedianMs: median(rows.map(r => r.wall)), wallWorstMs: Math.round(Math.max(...rows.map(r => r.wall))), taskMs: median(rows.map(r => r.task)), scriptMs: median(rows.map(r => r.script)),
            layoutMs: median(rows.map(r => r.layout)), styleMs: median(rows.map(r => r.style)), longTasks: median(rows.map(r => r.longTasks)), longMs: median(rows.map(r => r.longMs)), requests: median(rows.map(r => r.requests)),
            kb: Math.round(median(rows.map(r => r.bytes)) / 1024), apiPaths: median(rows.map(r => r.apis)), slowest: rows[rows.length - 1].slowest, unsettled: rows.filter(r => !r.ok).length,
            abandoned: rows.flatMap(r => r.abandoned).reduce((m, a) => { const k = a.url.slice(0, 100); const o = m.get(k) || { url: k, runs: 0, maxAgeMs: 0 }; o.runs++; o.maxAgeMs = Math.max(o.maxAgeMs, Math.round(a.ageMs)); m.set(k, o); return m; }, new Map()) };
        s.abandoned = [...s.abandoned.values()].sort((a, b) => b.maxAgeMs - a.maxAgeMs).slice(0, 5);
        out.screens.push(s);
        console.log(`${name.padEnd(34)} wall ${String(s.wallMedianMs).padStart(7)} (worst ${String(s.wallWorstMs).padStart(6)})  task ${String(Math.round(s.taskMs)).padStart(5)}  script ${String(Math.round(s.scriptMs)).padStart(5)}  long ${s.longTasks}/${Math.round(s.longMs)}ms  req ${s.requests}  ${s.kb} KB  slowest ${s.slowest}${s.abandoned.length ? `  ABANDONED(open >8 s at settle): ${s.abandoned.map(a => `${a.url} x${a.runs} ${a.maxAgeMs}ms`).join(' | ')}` : ''}`);
    }
    fs.writeFileSync(process.env.OUT || 'browser.json', JSON.stringify(out, null, 1));
    await client.close();
})().catch(e => { console.error(e); process.exit(1); });
