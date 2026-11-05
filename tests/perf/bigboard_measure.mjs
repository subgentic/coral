import { typingGateExitCode } from './typing_trace.mjs';
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
if (process.env.TYPING_GATE === '1' && process.env.TYPING_TRACE !== '1') { console.error('[measure] TYPING_GATE requires TYPING_TRACE=1'); process.exit(2); }
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

// Chrome: a fresh profile per try, the flags an automated run wants (no keychain prompt, no updater or component update, no background networking), a 25 s deadline for the
// DevTools port, and the spawned process killed by PID before the next try (a launch that hung once did not come back in 90 s: #13154's 9 tries in a row).
const CHROME_FLAGS = ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', '--use-mock-keychain', '--password-store=basic',
    '--disable-background-networking', '--disable-component-update', '--no-service-autorun', '--disable-sync', ...(process.env.CI ? ['--no-sandbox'] : [])];
const CHROME_ATTEMPTS = process.env.TYPING_TRACE === '1' ? 1 : 4;
let profile = '', chrome = null, chromeErr = '', chromeExit = '';
const launchChrome = async () => {
    for (let attempt = 1; attempt <= CHROME_ATTEMPTS; attempt++) {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bigboard-chrome.')); chromeErr = ''; chromeExit = '';
        chrome = spawn(chromePath, [...CHROME_FLAGS, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
        chrome.stderr.on('data', d => { chromeErr = (chromeErr + d).slice(-3000); });
        chrome.on('exit', (c, sig) => { chromeExit = `exit ${c} ${sig}`; });
        let port = 0;
        for (const end = Date.now() + 25000; !port && Date.now() < end; await sleep(100)) {
            try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch {}
        }
        if (port) { if (attempt > 1) console.log('[measure] Chrome opened its DevTools port on try ' + attempt); return port; }
        console.error(`[measure] Chrome try ${attempt}: no DevTools port in 25 s (${chromeExit || 'still running'}) ${chromeErr.split('\n').filter(l => /ERROR|FATAL/.test(l)).slice(0, 2).join(' | ').slice(0, 200)}`);
        try { chrome.kill('SIGKILL'); } catch {}
        await sleep(1500); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    }
    throw new Error('Chrome did not open its DevTools port in ' + CHROME_ATTEMPTS + ' attempt(s)');
};
let client;
const done = async code => { try { await client?.close(); } catch {} try { chrome.kill('SIGTERM'); } catch {} await sleep(500); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); };
process.on('SIGINT', () => done(130));

(async () => {
    const port = await launchChrome();
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
    const reqs = new Map(); const rows = []; let phase = 'load'; let t0 = 0; let started = 0; let lastActivity = Date.now();
    Network.requestWillBeSent(e => { if (e.request.url.startsWith(BASE)) { started++; lastActivity = Date.now(); } if (e.request.url.startsWith(BASE)) reqs.set(e.requestId, { url: e.request.url, method: e.request.method, sent: e.timestamp, phase, at: e.timestamp, type: e.type }); });
    Network.responseReceived(e => { const r = reqs.get(e.requestId); if (r) r.status = e.response.status; });
    Network.loadingFinished(e => { const r = reqs.get(e.requestId); if (!r) return; r.end = e.timestamp; r.bytes = e.encodedDataLength; rows.push(r); reqs.delete(e.requestId); lastActivity = Date.now(); });
    Network.loadingFailed(e => { const r = reqs.get(e.requestId); if (!r) return; r.end = e.timestamp; r.bytes = 0; r.status = 0; rows.push(r); reqs.delete(e.requestId); lastActivity = Date.now(); });

    // ── the load ──
    const token = TOKEN_FILE && fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
    // API_KEY_FILE: no sign-in at all, every request carries the server's API key (what an agent's own tools send); the pages and the API answer as for a signed-in browser
    if (process.env.API_KEY_FILE) await Network.setExtraHTTPHeaders({ headers: { Authorization: 'Bearer ' + fs.readFileSync(process.env.API_KEY_FILE, 'utf8').trim() } });
    // sign in the way a person does: the locked page's "Open Coral on this computer" form (no token needed, so any number of runs on one server);
    // then the measured load starts from a cleared cache, signed in, as a first visit of the day
    await Page.navigate({ url: BASE + (token ? '/?login_token=' + token : '/') });
    await Page.loadEventFired();
    if (await ev(`!!document.getElementById('local-open-form')`)) {
        await ev(`document.getElementById('local-open-form').submit(); true`, false);
        for (const end = Date.now() + 20000; Date.now() < end; await sleep(200)) { // signed in: the form's redirect has landed on the app
            if (await ev(`document.readyState === 'complete' && !document.getElementById('local-open-form')`).catch(() => false)) break;
        }
    }
    await Network.clearBrowserCache();
    for (const k of rows.splice(0)) void k; reqs.clear(); started = 0;
    // sidebar and tab counts as times: from the start of the page, the first moment each count says a number above 0 (polled every 50 ms in the page)
    const COUNT_IDS = ['nav-tab-hub-inbox-badge', 'saved-tab-count', 'nav-tab-skills-badge', 'history-tasks-count', 'history-activity-count', 'team-agents-count'];
    await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const ids = ${JSON.stringify(COUNT_IDS)}; window.__counts = {}; const tick = () => { for (const id of ids) { const e = document.getElementById(id); const t = e && e.textContent.trim(); if (t && /[1-9]/.test(t) && !(id in window.__counts)) window.__counts[id] = { ms: Math.round(performance.now()), text: t }; } }; setInterval(tick, 50); })();` });
    t0 = Date.now();
    await Page.navigate({ url: BASE + '/' });
    await Page.loadEventFired();
    // the app is ready when its start has finished and the agent list has loaded (the events the suites wait for)
    const ready = await ev(`new Promise(res => { const t0 = performance.now(); const ok = () => (window.__coralReady && window.__coralReady.startup) ; const iv = setInterval(() => {
        const list = document.querySelector('#live-sessions-list'); const rowsN = list ? list.children.length : 0;
        if (rowsN > 0 || performance.now() - t0 > 60000) { clearInterval(iv); res({ rows: rowsN, waited: performance.now() - t0 }); } }, 50); })`);
    const loadMs = Date.now() - t0;
    // The first load is over when no request of the page is still OPEN (a stream, an EventSource or a WebSocket, is not counted: it never ends) and nothing has started or finished for 1.5 s
    // (or 120 s). The time is that of the LAST start or finish, from the navigation (#13377: it used to ignore open requests, so a 2.6 s list still in flight counted as settled at 218 ms).
    const STREAMS = new Set(['EventSource', 'WebSocket', 'Ping', 'Other']);
    for (const end = Date.now() + 120000; Date.now() < end; await sleep(100)) {
        const open = [...reqs.values()].filter(r => !STREAMS.has(r.type));
        if (!open.length && Date.now() - lastActivity > 1500) break;
    }
    const settledMs = lastActivity - t0;
    const nav = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; const lcp = performance.getEntriesByType('largest-contentful-paint').pop(); const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return { domContentLoaded: n && n.domContentLoadedEventEnd, load: n && n.loadEventEnd, fcp: fcp && fcp.startTime, lcp: lcp && lcp.startTime }; })()`);
    let out_interactions = {}; let idleEnd = 0; const out_profiles = {};
    const counts = await ev(`window.__counts || {}`);
    // Needs you within 20 s of the load (coral-hub's worst case: the click comes while the page's own counts are still coming in): the Inbox tab and the first file, timed
    const early = {};
    if (Date.now() - t0 < 20000 || process.env.EARLY_ALWAYS) {
        early.seconds_after_load_start = Math.round((Date.now() - t0) / 100) / 10;
        phase = 'early';
        const e1 = await ev(`(async () => { const t = performance.now(); const tab = document.getElementById('nav-tab-hub-inbox'); if (!tab) return { error: 'no inbox tab' }; tab.click();
            const v = await new Promise(res => { const t0 = performance.now(); const tick = () => { if (document.querySelectorAll('#group-table-view tbody tr').length > 0) res(performance.now() - t0); else if (performance.now() - t0 > 30000) res(-1); else setTimeout(tick, 16); }; tick(); }); return v; })()`).catch(e => ({ error: String(e.message || e).slice(0, 120) }));
        const e2 = await ev(`(async () => { const row = [...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.querySelector('.inbox-review-name')); if (!row) return { error: 'no review row' };
            const t0 = performance.now(); row.querySelector('.inbox-review-name').click(); return await new Promise(res => { const tick = () => { const e = document.getElementById('artifact-viewer-title'); if (e && e.offsetParent !== null && e.textContent.trim().length > 0) res(performance.now() - t0); else if (performance.now() - t0 > 30000) res(-1); else setTimeout(tick, 16); }; tick(); }); })()`).catch(e => ({ error: String(e.message || e).slice(0, 120) }));
        early.ms_to_rows = typeof e1 === 'number' ? Math.round(e1) : e1; early.ms_row_click_to_viewer = typeof e2 === 'number' ? Math.round(e2) : e2; // -1: not within 30 s
        // a fresh load for the idle minute (the Inbox is open now)
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await sleep(3000);
    }
    // ── profiles (PPROF_URL, PROFILE_PREFIX): a CPU profile of the server during the idle minute and one while an agent is open and polling (Backend Dev's #13182) ──
    const PPROF = process.env.PPROF_URL, PREFIX = process.env.PROFILE_PREFIX, PROF_S = Number(process.env.PROFILE_S || 40);
    const profile = async (label) => { if (!PPROF || !PREFIX) return null; try { const r = await fetch(`${PPROF}/debug/pprof/profile?seconds=${PROF_S}`); const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(`${PREFIX}-${label}.pb.gz`, b); return b.length; } catch (e) { return String(e.message || e); } };
    // ── idle ──
    phase = 'idle'; const idleFrom = rows.length; const idleStarted = started;
    for (const r of reqs.values()) r.phase = 'load';
    const idleProf = profile('idle'); // runs for PROF_S seconds inside the idle minute (start it first: the profile call blocks that long)
    await sleep(Math.max(IDLE_S, PROF_S + 2) * 1000);
    out_profiles.idle = await idleProf;
    idleEnd = rows.length; phase = 'action';

    // ── interactions: each timed in the page (performance.now), one at a time, each in its own try so one broken selector leaves the others ──
    // The page-side helper waits for a condition on animation frames and reports how long it took (null on the 60 s cap).
    const CAP = Number(process.env.STEP_CAP_MS || 30000);
    const WAIT = `window.__until = (cond, cap = ${CAP}) => new Promise(res => { const t = performance.now(); const tick = () => { let v = false; try { v = cond(); } catch (e) {} if (v) res(performance.now() - t); else if (performance.now() - t > cap) res(null); else setTimeout(tick, 16); }; tick(); }); true`;
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
                await Promise.race([window.__coralReady.agentSelected(${JSON.stringify(a.id)}), new Promise(r => setTimeout(r, ${CAP}))]); const d = performance.now() - t; return d >= ${CAP} ? -1 : d; })()`)));
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
            const v = await window.__until(() => document.querySelectorAll('#changed-files-list > *').length > 3, ${CAP}); return { ms: v, rows: document.querySelectorAll('#changed-files-list > *').length, title: (document.getElementById('changed-files-title') || {}).textContent || '' }; })()`);
        const f = rows.slice(marker).filter(r => /files|changes|git|worktree/i.test(r.url)).map(r => ({ route: fold(new URL(r.url).pathname), ms: Math.round((r.end - r.sent) * 1000), bytes: r.bytes }));
        return { ...ms, requests: f };
    });
    // #13156: opt-in attribution on the real fixture, after Files has loaded.
    // Choose the actual remote identity, and refuse sleeping/ended agents.
    if (process.env.TYPING_TRACE === '1') {
        const { measureTypingBurst } = await import('./typing_trace.mjs');
        const traceDir = path.join(path.dirname(OUT), path.basename(OUT, '.json') + '-typing');
        // A requested confirmation subset never relaxes the complete two-target gate below.
        for (const target of ['composer', 'terminal'].filter(t => !process.env.TYPING_TARGETS || process.env.TYPING_TARGETS.split(',').includes(t))) await step('typing_trace_' + target, async () => {
            const agent = await ev(`fetch('/api/sessions/live').then(r=>r.json()).then(j=>(Array.isArray(j)?j:j.sessions||[]).find(a=>!a.sleeping&&!a.archived&&a.agent_type!=='terminal'))`);
            if (!agent) throw new Error('No awake mock agent: restart/wake fixture agents on the isolated copy before tracing');
            await ev(`(async()=>{await window.selectLiveSession(${JSON.stringify(agent.name)},${JSON.stringify(agent.agent_type || 'claude')},${JSON.stringify(agent.session_id)},${JSON.stringify(agent.server || 'local')});window.switchAgenticTab('files','top');window.setLiveViewMode(${JSON.stringify(target === 'composer' ? 'chat' : 'terminal')});const x=await import((window.__coralStatic||'/static/')+'xterm_renderer.js');const ready=await window.__until(()=>{const el=document.querySelector(${JSON.stringify(target === 'composer' ? '#command-input' : '#xterm-container .xterm-helper-textarea')}),files=document.getElementById('changed-files-list');return !!el&&!el.disabled&&el.getClientRects().length>0&&!!files&&files.getClientRects().length>0&&${target === 'terminal' ? 'x.isTerminalWsOpen()' : 'true'};},${CAP});if(ready===null)throw Error('Live input/Files not ready');return true;})()`);
            return measureTypingBurst({client,ev,outDir:traceDir,target,label:target,characters:200});
        });
    }
    // Needs you: the Inbox tab, then the first file for review opened; the time from the click to the viewer on screen, and the rows
    await step('needs_you_open', async () => {
        const m0 = rows.length;
        const t1 = await ev(`(async () => { const t = performance.now(); const tab = document.getElementById('nav-tab-hub-inbox'); if (!tab) return { error: 'no inbox tab' }; tab.click();
            const v = await window.__until(() => document.querySelectorAll('#group-table-view tbody tr').length > 0, ${CAP}); return v; })()`);
        const t2 = await ev(`(async () => { const row = [...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.querySelector('.inbox-review-name')); if (!row) return { error: 'no review row' };
            const t = performance.now(); row.querySelector('.inbox-review-name').click(); return await window.__until(() => { const e = document.getElementById('artifact-viewer-title'); return e && e.offsetParent !== null && e.textContent.trim().length > 0; }, ${CAP}); })()`);
        return { ms_to_rows: typeof t1 === 'number' ? Math.round(t1) : t1, ms_row_click_to_viewer: typeof t2 === 'number' ? Math.round(t2) : t2, requests: rows.slice(m0).filter(r => !new URL(r.url).pathname.startsWith('/static/')).length };
    });
    // the poll load: an agent open (the page polls it and its terminal) for PROF_S seconds, profiled
    if (PPROF && PREFIX && live.length) {
        await ev(`window.selectLiveSession(${JSON.stringify(live[0].name)}, ${JSON.stringify(live[0].type || 'claude')}, ${JSON.stringify(live[0].id)}, 'local'); true`);
        const m0 = rows.length; const pp = profile('poll'); await sleep((PROF_S + 2) * 1000); out_profiles.poll = await pp;
        const polls = rows.slice(m0).filter(r => /poll|capture|event|worktree/i.test(r.url)).length; out_profiles.poll_requests = polls;
    }
    if (PPROF && PREFIX) for (const k of ['mutex', 'block', 'heap']) { try { const r = await fetch(`${PPROF}/debug/pprof/${k}`); fs.writeFileSync(`${PREFIX}-${k}.pb.gz`, Buffer.from(await r.arrayBuffer())); } catch {} }
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
        idle: { seconds: IDLE_S, requests: idleEnd - idleFrom }, routes, interactions: { ...out_interactions, sidebar_counts_first_nonzero: counts, needs_you_early: early }, profiles: out_profiles };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ load: out.load, idle: out.idle }));
    for (const r of routes.slice(0, 14)) console.log(`${r.phase.padEnd(5)} ${String(r.p95).padStart(8)} ms p95 ${String(r.p50).padStart(8)} p50 ${String(r.max).padStart(8)} max  n=${String(r.n).padStart(3)}  ${String(r.bytes_each).padStart(8)} B  ${r.route}`);
    await done(typingGateExitCode(interactions, process.env.TYPING_GATE === '1', process.env.TYPING_TRACE === '1'));
})().catch(async e => { console.error('[measure] ' + (e.stack || e)); await done(1); });
