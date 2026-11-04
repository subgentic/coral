// bigboard_measure.mjs BASE LOGIN_TOKEN_FILE OUT.json   (#13154, goal #215)
//
// Measures the dashboard against a server running on the big-board fixture (bigboard_seed.sh), the way a person meets it: a headless
// Chrome (a temp profile, a 1400x900 desktop) loads the page and every request the page makes is recorded over CDP (Network domain):
// the path with its ids folded, when it started, how long it took (request sent to last byte), the bytes on the wire, the status.
//   phase "load"  : from the navigation until the app says it is ready (startup + the live list), with the time to that point;
//   phase "idle"  : IDLE_S seconds (default 60) of the page left alone: the polls it makes on its own;
//   interactions  : see INTERACTIONS below (each timed in the page with performance.now(), one at a time).
// Writes OUT.json: { load: {ms, requests}, idle: {seconds, requests}, routes: [{route, phase, n, p50, p95, max, bytes, status}], interactions: {...} }.
// Never starts a server and never touches ~/.coral or :8420: BASE is given, and refused if it is :8420. Needs tests/frontend/node_modules
// (chrome-remote-interface). Opt-in like the other perf harness: PERF_RUN=1.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.PERF_RUN !== '1') { console.error('[measure] opt-in: set PERF_RUN=1'); process.exit(2); }
const [BASE, TOKEN_FILE, OUT] = process.argv.slice(2);
if (!BASE || !OUT) { console.error('usage: PERF_RUN=1 node bigboard_measure.mjs BASE LOGIN_TOKEN_FILE OUT.json'); process.exit(2); }
const url = new URL(BASE);
if (!url.port || url.port === '8420') { console.error('[measure] refusing ' + BASE + ': an explicit non-8420 port is required'); process.exit(2); }
const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, '..', 'frontend', 'package.json'));
const CDP = require('chrome-remote-interface');
const IDLE_S = Number(process.env.IDLE_S || 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const chromePath = process.env.CHROME || CHROMES.find(p => fs.existsSync(p));
if (!chromePath) { console.error('[measure] no Chrome found (set CHROME)'); process.exit(2); }

// the path with its ids folded, so every board, session and file of one route is one row
const fold = p => p.replace(/[0-9a-f]{64}/g, '{hex}').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{uuid}')
    .replace(/\/b-[a-z0-9]{6,}/g, '/{board}').replace(/\/agent-\d+/g, '/{agent}').replace(/\/\d+(?=\/|$)/g, '/{n}');
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bigboard-chrome.'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1400,900', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
let client;
const done = async code => { try { await client?.close(); } catch {} try { chrome.kill('SIGTERM'); } catch {} await sleep(500); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); };
process.on('SIGINT', () => done(130));

(async () => {
    let port = 0;
    for (const end = Date.now() + 30000; !port && Date.now() < end; await sleep(100)) {
        try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch {}
    }
    if (!port) throw new Error('Chrome did not open its DevTools port');
    client = await CDP({ port });
    const { Page, Runtime, Network, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
    await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    // a headless page on the Mac is hidden after a while and then runs no timers or frames: keep it visible (as the suites do)
    await Emulation.setFocusEmulationEnabled({ enabled: true }).catch(() => {});

    const ev = async (expression, awaitPromise = true) => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
    };

    // ── request recording ──
    const reqs = new Map(); const rows = []; let phase = 'load'; let t0 = 0; let started = 0;
    Network.requestWillBeSent(e => { if (e.request.url.startsWith(BASE)) started++; if (e.request.url.startsWith(BASE)) reqs.set(e.requestId, { url: e.request.url, method: e.request.method, sent: e.timestamp, phase, at: e.timestamp }); });
    Network.responseReceived(e => { const r = reqs.get(e.requestId); if (r) r.status = e.response.status; });
    Network.loadingFinished(e => { const r = reqs.get(e.requestId); if (!r) return; r.end = e.timestamp; r.bytes = e.encodedDataLength; rows.push(r); reqs.delete(e.requestId); });
    Network.loadingFailed(e => { const r = reqs.get(e.requestId); if (!r) return; r.end = e.timestamp; r.bytes = 0; r.status = 0; rows.push(r); reqs.delete(e.requestId); });

    // ── the load ──
    const token = TOKEN_FILE && fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
    t0 = Date.now();
    await Page.navigate({ url: BASE + (token ? '/?login_token=' + token : '/') });
    await Page.loadEventFired();
    // the app is ready when its start has finished and the agent list has loaded (the events the suites wait for)
    const ready = await ev(`new Promise(res => { const t0 = performance.now(); const ok = () => (window.__coralReady && window.__coralReady.startup) ; const iv = setInterval(() => {
        const list = document.querySelector('#live-sessions-list'); const rowsN = list ? list.children.length : 0;
        if (rowsN > 0 || performance.now() - t0 > 120000) { clearInterval(iv); res({ rows: rowsN, waited: performance.now() - t0 }); } }, 50); })`);
    const loadMs = Date.now() - t0;
    // the first load is over once the page has started no new request for 1.5 s (or 120 s): a request still open (a stream) does not hold it
    let quietSince = Date.now(); let lastStarted = started;
    for (const end = Date.now() + 120000; Date.now() < end; await sleep(100)) {
        if (started !== lastStarted) { lastStarted = started; quietSince = Date.now(); } else if (Date.now() - quietSince > 1500) break;
    }
    const settledMs = Date.now() - t0 - 1500;
    const nav = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; const lcp = performance.getEntriesByType('largest-contentful-paint').pop(); const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return { domContentLoaded: n && n.domContentLoadedEventEnd, load: n && n.loadEventEnd, fcp: fcp && fcp.startTime, lcp: lcp && lcp.startTime }; })()`);
    let out_interactions = {}; let idleEnd = 0;
    // ── idle ──
    phase = 'idle'; const idleFrom = rows.length; const idleStarted = started;
    for (const r of reqs.values()) r.phase = 'load';
    await sleep(IDLE_S * 1000);
    idleEnd = rows.length; phase = 'action';

    // ── interactions: each timed in the page (performance.now), one at a time, each in its own try so one broken selector leaves the others ──
    // The page-side helper waits for a condition on animation frames and reports how long it took (null on the 60 s cap).
    const WAIT = `window.__until = (cond, cap = 60000) => new Promise(res => { const t = performance.now(); const tick = () => { let v = false; try { v = cond(); } catch (e) {} if (v) res(performance.now() - t); else if (performance.now() - t > cap) res(null); else setTimeout(tick, 16); }; tick(); }); true`;
    await ev(WAIT);
    const interactions = {};
    const step = async (name, fn) => { try { interactions[name] = await fn(); } catch (e) { interactions[name] = { error: String(e.message || e).slice(0, 200) }; } console.log('[measure] ' + name + ': ' + JSON.stringify(interactions[name])); };
    const longTasks = `(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch (e) {} return true; })()`;
    await ev(longTasks);
    const live = await ev(`fetch('/api/sessions/live').then(r => r.json()).then(j => (Array.isArray(j) ? j : j.sessions || []).map(s => ({ name: s.name, id: s.session_id, type: s.agent_type })))`);
    // sidebar counts: the Inbox badge is drawn from the lists the page reads (the load already ran; this is the time the badge says a number now, 0 if it does not)
    await step('inbox_badge_text', () => ev(`(document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || ''`));
    // agent switch: five switches between two agents, the time until the composer of the chosen agent is usable
    await step('agent_switch_ms', async () => {
        if (live.length < 2) return { error: 'fewer than 2 live sessions' };
        const out = [];
        for (let i = 0; i < 6; i++) {
            const a = live[i % 2];
            out.push(Math.round(await ev(`(async () => { const t = performance.now(); window.selectLiveSession(${JSON.stringify(a.name)}, ${JSON.stringify(a.type || 'claude')}, ${JSON.stringify(a.id)}, 'local');
                await Promise.race([window.__coralReady.agentSelected(${JSON.stringify(a.id)}), new Promise(r => setTimeout(r, 60000))]); return performance.now() - t; })()`)));
            await sleep(300);
        }
        return { ms: out, p50: pct(out, 0.5), max: Math.max(...out) };
    });
    // typing in an agent: 60 keys one at a time; the time from the key event to the next frame, and the page's long tasks while typing
    await step('typing', async () => {
        await ev(`(() => { const c = document.getElementById('command-input'); c.focus(); window.__lt.length = 0; return !!c; })()`);
        const lat = [];
        for (const ch of 'the quick brown fox jumps over the lazy dog, a few more words to type in the box ok') {
            const t = Date.now();
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: ch, text: ch });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key: ch });
            await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
            lat.push(Date.now() - t); await sleep(20);
        }
        const lt = await ev(`window.__lt.slice()`);
        return { keys: lat.length, p50_ms: pct(lat, 0.5), p95_ms: pct(lat, 0.95), max_ms: Math.max(...lat), long_tasks: lt.length, longest_task_ms: Math.round(Math.max(0, ...lt)) };
    });
    // the Files panel of an agent whose folder is the big repo: the time from the click until the list has rows
    await step('files_panel', async () => {
        const marker = rows.length;
        const ms = await ev(`(async () => { const t = performance.now(); const tab = document.getElementById('agentic-tab-files'); if (!tab) return { error: 'no files tab' }; tab.click();
            const v = await window.__until(() => document.querySelectorAll('#changed-files-list > *').length > 3, 90000); return { ms: v, rows: document.querySelectorAll('#changed-files-list > *').length, title: (document.getElementById('changed-files-title') || {}).textContent || '' }; })()`);
        const f = rows.slice(marker).filter(r => /files|changes|git|worktree/i.test(r.url)).map(r => ({ route: fold(new URL(r.url).pathname), ms: Math.round((r.end - r.sent) * 1000), bytes: r.bytes }));
        return { ...ms, requests: f };
    });
    // #13156: opt-in attribution on the real fixture, after Files has loaded.
    // Choose the actual remote identity, and refuse sleeping/ended agents.
    if (process.env.TYPING_TRACE === '1') {
        const { measureTypingBurst } = await import('./typing_trace.mjs');
        const traceDir = path.join(path.dirname(OUT), path.basename(OUT, '.json') + '-typing');
        for (const target of ['composer', 'terminal']) await step('typing_trace_' + target, async () => {
            const agent = await ev(`fetch('/api/sessions/live').then(r=>r.json()).then(j=>(Array.isArray(j)?j:j.sessions||[]).find(a=>!a.sleeping&&!a.archived&&a.agent_type!=='terminal'))`);
            if (!agent) throw new Error('No awake mock agent: restart/wake fixture agents on the isolated copy before tracing');
            await ev(`(async()=>{await window.selectLiveSession(${JSON.stringify(agent.name)},${JSON.stringify(agent.agent_type || 'claude')},${JSON.stringify(agent.session_id)},${JSON.stringify(agent.server || 'local')});window.switchAgenticTab('files','top');window.setLiveViewMode(${JSON.stringify(target === 'composer' ? 'chat' : 'terminal')});const x=await import((window.__coralStatic||'/static/')+'xterm_renderer.js');const ready=await window.__until(()=>{const el=document.querySelector(${JSON.stringify(target === 'composer' ? '#command-input' : '#xterm-container .xterm-helper-textarea')}),files=document.getElementById('changed-files-list');return !!el&&!el.disabled&&el.getClientRects().length>0&&!!files&&files.getClientRects().length>0&&${target === 'terminal' ? 'x.isTerminalWsOpen()' : 'true'};},30000);if(ready===null)throw Error('Live input/Files not ready');return true;})()`);
            return measureTypingBurst({client,ev,outDir:traceDir,target,label:target,characters:200});
        });
    }
    // Needs you: the Inbox tab, then the first file for review opened; the time from the click to the viewer on screen, and the rows
    await step('needs_you_open', async () => {
        const m0 = rows.length;
        const t1 = await ev(`(async () => { const t = performance.now(); const tab = document.getElementById('nav-tab-hub-inbox'); if (!tab) return { error: 'no inbox tab' }; tab.click();
            const v = await window.__until(() => document.querySelectorAll('#group-table-view tbody tr').length > 0, 90000); return v; })()`);
        const t2 = await ev(`(async () => { const row = [...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.querySelector('.inbox-review-name')); if (!row) return { error: 'no review row' };
            const t = performance.now(); row.querySelector('.inbox-review-name').click(); return await window.__until(() => { const e = document.getElementById('artifact-viewer-title'); return e && e.offsetParent !== null && e.textContent.trim().length > 0; }, 90000); })()`);
        return { ms_to_rows: typeof t1 === 'number' ? Math.round(t1) : t1, ms_row_click_to_viewer: typeof t2 === 'number' ? Math.round(t2) : t2, requests: rows.slice(m0).filter(r => !new URL(r.url).pathname.startsWith('/static/')).length };
    });
    out_interactions = interactions;
    // ── the table ──
    const by = new Map();
    for (const r of rows) {
        const u = new URL(r.url); if (u.pathname.startsWith('/static/')) continue;
        const key = r.phase + ' ' + r.method + ' ' + fold(u.pathname);
        const o = by.get(key) || { route: r.method + ' ' + fold(u.pathname), phase: r.phase, ms: [], bytes: 0, status: {} };
        o.ms.push((r.end - r.sent) * 1000); o.bytes += r.bytes || 0; o.status[r.status] = (o.status[r.status] || 0) + 1; by.set(key, o);
    }
    const routes = [...by.values()].map(o => ({ route: o.route, phase: o.phase, n: o.ms.length, p50: +pct(o.ms, 0.5).toFixed(1), p95: +pct(o.ms, 0.95).toFixed(1), max: +Math.max(...o.ms).toFixed(1),
        bytes: o.bytes, bytes_each: Math.round(o.bytes / o.ms.length), status: o.status })).sort((a, b) => b.p95 - a.p95);
    const out = { base: BASE, chrome: chromePath, at: new Date().toISOString(), load: { ready_rows: ready.rows, ms_to_agent_list: loadMs, ms_to_settled: settledMs, nav, requests: rows.filter(r => r.phase === 'load').length, static_files: rows.filter(r => new URL(r.url).pathname.startsWith('/static/')).length },
        idle: { seconds: IDLE_S, requests: idleEnd - idleFrom }, routes, interactions: out_interactions };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ load: out.load, idle: out.idle }));
    for (const r of routes.slice(0, 14)) console.log(`${r.phase.padEnd(5)} ${String(r.p95).padStart(8)} ms p95 ${String(r.p50).padStart(8)} p50 ${String(r.max).padStart(8)} max  n=${String(r.n).padStart(3)}  ${String(r.bytes_each).padStart(8)} B  ${r.route}`);
    const typingFailed = ['composer','terminal'].some(target => interactions['typing_trace_' + target]?.budgetPassed !== true);
    await done(process.env.TYPING_GATE === '1' && (process.env.TYPING_TRACE !== '1' || typingFailed) ? 1 : 0);
})().catch(async e => { console.error('[measure] ' + (e.stack || e)); await done(1); });
