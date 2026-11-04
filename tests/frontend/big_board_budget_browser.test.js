// cdp-timeout: 240 (seeds 20,000 uploads and 2,000 tasks into the runner's isolated server, then measures; a Mac seeds in about a minute)
// The big-board budgets in the browser (#13326, goal #215, tier 2 of #13157): a server holding the Operator's big board (20,000 uploads = 200 files x 100 versions, all tagged "for review", 2,000 tasks, 1,000 board
// messages, one live terminal agent) and the page the way a person meets it, held to the goal's budgets: the first load to an interactive agent list under 2 s, the Inbox's Needs you rows under 1 s on a settled page
// and under 3 s within 20 s of a load, and no long task over 50 ms while typing in the agent's command box. The uploads are written into the server's data folder as an agent's upload leaves them (object, sidecar, the
// session's upload record), their review tags and the tasks go into the isolated databases, the board and messages through the real API. Everything it makes is removed on every way out (its board, tasks, files, tags).
// Budgets are ceilings: CORAL_BIGBOARD_SCALE multiplies them (0.001 shows the suite failing as a regression would). CORAL_BIGBOARD_FILES / _VERSIONS shrink the seed for a smoke run. Isolated dev server only.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { sqliteExec } = require('./helpers/sqlite');
const { removeBoards } = require('./helpers/board_cleanup');

const DATA = process.env.CORAL_TEST_DATA_DIR || '';
const FILES = Number(process.env.CORAL_BIGBOARD_FILES) || 200, VERSIONS = Number(process.env.CORAL_BIGBOARD_VERSIONS) || 100, TASKS = 2000, MESSAGES = 1000;
const SCALE = Number(process.env.CORAL_BIGBOARD_SCALE) > 0 ? Number(process.env.CORAL_BIGBOARD_SCALE) : 1;
const BUDGET = { firstLoadMs: 2000 * SCALE, needsYouWarmMs: 1000 * SCALE, needsYouEarlyMs: 3000 * SCALE, longTaskMs: 50 * SCALE }; // the goal's numbers
const TAG = Date.now() % 100000;
const B = 'bigboard-13326-' + TAG, SESSION = '13326000-0000-4000-8000-' + String(TAG).padStart(12, '0');

(async () => {
    assert.ok(DATA, 'run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)');
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation, Input } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor, coralReady, nextFrame } = require('./helpers/wait').bind(ev);
    const objects = path.join(DATA, 'artifacts', 'objects'), uploads = path.join(DATA, 'artifacts', 'uploads', SESSION), boardDb = path.join(DATA, 'messageboard.db');
    const written = []; // the object ids this run wrote: removed again
    let agent = null, cleaned = null;
    const cleanUp = () => (cleaned ||= (async () => {
        try { if (agent) await ev(`fetch('/api/sessions/live/' + ${JSON.stringify(agent.session_name)} + '/kill', { method: 'POST' }).then(r => r.status)`); } catch { /* the agent may be gone */ }
        try { sqliteExec(boardDb, `PRAGMA busy_timeout=20000; DELETE FROM artifact_tags WHERE board_id = '${B}'; DELETE FROM board_tasks WHERE board_id = '${B}';`); } catch { /* nothing seeded yet */ }
        await removeBoards(ev, [B]).catch(() => {});
        try { fs.rmSync(uploads, { recursive: true, force: true }); } catch { /* none */ }
        for (const id of written) { try { fs.unlinkSync(path.join(objects, id)); fs.unlinkSync(path.join(objects, id + '.json')); } catch { /* gone */ } }
        await client.close().catch(() => {});
    })());
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cleanUp().then(() => process.exit(130)); });
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const results = {};
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();

        console.log(`seeding ${FILES * VERSIONS} uploads, ${TASKS} tasks, ${MESSAGES} messages into ${B}`);
        const t0 = Date.now();
        fs.mkdirSync(objects, { recursive: true }); fs.mkdirSync(uploads, { recursive: true });
        const base = Date.now() - 48 * 3600 * 1000, rows = [];
        for (let i = 0; i < FILES * VERSIONS; i++) {
            const name = `doc-${String(i % FILES).padStart(3, '0')}.md`, content = `version ${Math.floor(i / FILES)} of ${name} (${TAG})\n`;
            const id = crypto.createHash('sha256').update(content + name + TAG).digest('hex');
            const meta = { name, media_type: 'text/markdown', size: Buffer.byteLength(content), digest: 'sha256:' + id };
            fs.writeFileSync(path.join(objects, id), content); fs.writeFileSync(path.join(objects, id + '.json'), JSON.stringify({ ...meta, digest: id }));
            fs.writeFileSync(path.join(uploads, id + '.json'), JSON.stringify({ ...meta, created_at: new Date(base + i * 1000).toISOString(), board: B, uploader: 'Seed Agent', role: 'Dev' }));
            written.push(id); rows.push(`('${B}','${id}','for review')`);
        }
        for (let i = 0; i < rows.length; i += 2000) sqliteExec(boardDb, `PRAGMA busy_timeout=20000; INSERT OR IGNORE INTO artifact_tags (board_id, hex, tag) VALUES ${rows.slice(i, i + 2000).join(',')};`);
        await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Seed Agent', job_title: 'Dev', session_name: 'seed-agent-s' });
        const made = await ev(`(async () => { let bad = 0; const post = (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => { if (!r.ok) bad++; });
            for (let i = 0; i < ${TASKS}; i += 20) await Promise.all(Array.from({ length: 20 }, (_, k) => post('/api/board/${B}/tasks', { title: 'task ' + (i + k), body: 'a body of a few words', priority: 'medium', subscriber_id: 'Operator' })));
            for (let i = 0; i < ${MESSAGES}; i++) await post('/api/board/${B}/messages', { subscriber_id: 'Seed Agent', content: 'message ' + i + ' on the big board' });
            return bad; })()`);
        assert.equal(made, 0, 'every task and message was accepted');
        agent = await ev(`fetch('/api/sessions/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ working_dir: ${JSON.stringify(require('node:os').tmpdir())}, agent_type: 'terminal', display_name: 'Budget Agent' }) }).then(r => r.json())`);
        assert.ok(agent && agent.session_id, 'the live agent launched: ' + JSON.stringify(agent));
        console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s; letting the upload folders settle`);
        await new Promise(r => setTimeout(r, 5000)); // sleep-ok: the upload folder cache trusts a folder only after it has been unchanged a few seconds, as in use

        // 1. first load: from the navigation to an interactive page (the app started, the agent list drawn), on a fresh page
        const loadFrom = Date.now();
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await ev(`new Promise(res => { const t0 = performance.now(); const iv = setInterval(() => { const l = document.querySelector('#live-sessions-list'); if ((window.__coralReady && window.__coralReady.startup && l && l.children.length > 0) || performance.now() - t0 > 30000) { clearInterval(iv); res(true); } }, 20); })`);
        results.firstLoadMs = Date.now() - loadFrom;
        // 2. Needs you within 20 s of the load ("early"), the Inbox tab to its first rows
        await ev(`window.__until = (cond, cap = 20000) => new Promise(res => { const t = performance.now(); const tick = () => { let v = false; try { v = cond(); } catch (e) {} if (v) res(performance.now() - t); else if (performance.now() - t > cap) res(null); else setTimeout(tick, 16); }; tick(); }); true`);
        results.needsYouEarlyMs = await ev(`(async () => { const tab = document.getElementById('nav-tab-hub-inbox'); if (!tab) return -1; tab.click(); const v = await window.__until(() => document.querySelectorAll('#group-table-view tbody tr').length > 0); return v === null ? -2 : Math.round(v); })()`);
        // 3. settled: the page has been open 20 s; leave Inbox and open it again
        await new Promise(r => setTimeout(r, Math.max(0, 20000 - (Date.now() - loadFrom)))); // sleep-ok: the budget is for a page that has settled (20 s after its load)
        await ev(`(() => { const t = document.getElementById('nav-tab-agents'); if (t) t.click(); return !!t; })()`);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the tab switch finishes
        results.needsYouWarmMs = await ev(`(async () => { const tab = document.getElementById('nav-tab-hub-inbox'); if (!tab) return -1; tab.click(); const v = await window.__until(() => document.querySelectorAll('#group-table-view tbody tr').length > 0); return v === null ? -2 : Math.round(v); })()`);
        // 4. typing in the agent's command box: long tasks while 60 keys go in one at a time
        await ev(`window.selectLiveSession(${JSON.stringify(agent.session_name)}, 'terminal', ${JSON.stringify(agent.session_id)}); true`);
        await waitFor(`!!document.getElementById('command-input')`, 'the command box', 15000);
        await ev(`(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask' }); } catch (e) {} const c = document.getElementById('command-input'); c.focus(); return true; })()`);
        for (const ch of 'the quick brown fox jumps over the lazy dog, a few more words to type in the box') {
            await Input.dispatchKeyEvent({ type: 'keyDown', key: ch, text: ch }); await Input.dispatchKeyEvent({ type: 'keyUp', key: ch });
            await nextFrame(); await new Promise(r => setTimeout(r, 20)); // sleep-ok: a typist's pace
        }
        const lt = await ev(`window.__lt.slice()`);
        results.typingLongestTaskMs = Math.round(Math.max(0, ...lt)); results.typingLongTasks = lt.length;
        console.log('big board budgets: ' + JSON.stringify(results) + ' against ' + JSON.stringify(BUDGET));

        assert.ok(results.firstLoadMs <= BUDGET.firstLoadMs, `first load to an interactive agent list took ${results.firstLoadMs} ms, over ${BUDGET.firstLoadMs} ms`);
        assert.ok(results.needsYouEarlyMs >= 0 && results.needsYouEarlyMs <= BUDGET.needsYouEarlyMs, `Needs you within 20 s of a load took ${results.needsYouEarlyMs} ms (-1: no Inbox tab, -2: no rows), over ${BUDGET.needsYouEarlyMs} ms`);
        assert.ok(results.needsYouWarmMs >= 0 && results.needsYouWarmMs <= BUDGET.needsYouWarmMs, `Needs you on a settled page took ${results.needsYouWarmMs} ms (-1: no Inbox tab, -2: no rows), over ${BUDGET.needsYouWarmMs} ms`);
        assert.ok(results.typingLongestTaskMs <= BUDGET.longTaskMs, `typing had a long task of ${results.typingLongestTaskMs} ms (${results.typingLongTasks} long tasks), over ${BUDGET.longTaskMs} ms`);
        console.log('PASS big board budgets: first load, Needs you (early and settled) and typing inside the goal\'s budgets');
    } finally { await cleanUp(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
