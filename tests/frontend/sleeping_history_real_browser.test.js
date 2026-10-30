// The chat history of a sleeping or ended agent loads and scrolls on the REAL isolated server, with nothing woken or started (#136431: the operator saw a blank chat above the "has ended" card). A sleeping
// agent and an Ended one (sleep_reason agent_exited) are seeded as live rows with a real Claude transcript of 40 exchanges in the server's own projects folder; the page selects each through the list the server
// sends and reads the messages it draws, then scrolls to the top for the earlier pages. At 1280 px and on a phone. The rows and files are removed again.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CDP = require('chrome-remote-interface');
const { sqliteExec } = require('./helpers/sqlite.js');
const BASE = require('./test_base').BASE;

const DATA = process.env.CORAL_TEST_DATA_DIR || '';
const HOME = DATA ? path.join(path.dirname(DATA), 'home') : '';
const SLEEPING = '33333333-0000-4000-8000-000000000001', ENDED = '33333333-0000-4000-8000-000000000002', GONE = '33333333-0000-4000-8000-000000000003', GONE_SLEEPING = '33333333-0000-4000-8000-000000000004';

(async () => {
    // The real page and the real server: not agent_view_harness, whose page answers the live list from its own stand-in agents (a seeded row would never be listed there).
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const db = q => sqliteExec(path.join(DATA, 'sessions.db'), q);
    const wd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coral-sleephist-')));
    const projects = path.join(HOME, '.claude', 'projects', wd.replace(/[^A-Za-z0-9]/g, '-'));
    try {
        assert.ok(DATA, 'run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)');
        fs.mkdirSync(projects, { recursive: true });
        let lines = '';
        for (let i = 0; i < 40; i++) {
            const mm = String(i).padStart(2, '0');
            lines += JSON.stringify({ type: 'user', timestamp: `2026-10-29T10:${mm}:00.000Z`, message: { content: `history question ${i}` } }) + '\n'
                + JSON.stringify({ type: 'assistant', timestamp: `2026-10-29T10:${mm}:05.000Z`, message: { content: [{ type: 'text', text: `history answer ${i}` }] } }) + '\n';
        }
        for (const sid of [SLEEPING, ENDED]) fs.writeFileSync(path.join(projects, sid + '.jsonl'), lines);
        const now = new Date().toISOString().replace('Z', '+00:00');
        db(`INSERT OR REPLACE INTO live_sessions (session_id, agent_type, agent_name, working_dir, created_at, is_sleeping, sleep_reason, status, board_name, resume_from_id) VALUES ('${SLEEPING}', 'claude', 'Sleepy', '${wd}', '${now}', 1, NULL, 'active', NULL, NULL), ('${ENDED}', 'claude', 'GDeveloper', '${wd}', '${now}', 1, 'agent_exited', 'active', NULL, NULL), ('${GONE}', 'claude', 'Gone Ended', '${wd}', '${now}', 1, 'agent_exited', 'active', 'sleepers', '33333333-0000-4000-8000-0000000000ff'), ('${GONE_SLEEPING}', 'claude', 'Gone Asleep', '${wd}', '${now}', 1, NULL, 'active', 'sleepers', NULL);`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        const t0 = Date.now();
        await waitFor(`fetch('/api/sessions/live').then(r => r.json()).then(l => (Array.isArray(l) ? l : l.sessions || []).some(s => s.session_id === '${SLEEPING}'))`, 'the seeded rows in the server\'s list', 30000);
        console.log('   rows listed after ' + (Date.now() - t0) + ' ms');
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            for (const [sid, name, label] of [[SLEEPING, 'Sleepy', 'sleeping'], [ENDED, 'GDeveloper', 'ended']]) {
                const at = `${w}px, ${label}: `;
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
                await ev(`localStorage.setItem('coral-live-view-mode', 'terminal'); true`); // the worst preference: a sleeping agent has no terminal and must show its history anyway
                await waitFor(`(window._coralGetLiveSessions() || []).some(s => s.session_id === '${sid}')`, `${at}the row in the live list`, 15000).catch(async e => { throw new Error(`${e.message}; live: ${JSON.stringify(await ev(`fetch('/api/sessions/live').then(async r => r.status + ' ' + (await r.text()).slice(0, 300))`))}; db: ${JSON.stringify(require('./helpers/sqlite.js').sqliteText(path.join(DATA, 'sessions.db'), `select session_id, is_sleeping, status, sleep_reason from live_sessions where session_id like '33333333%'`))}`); });
                await ev(`(async () => { window.selectLiveSession(${JSON.stringify(name)}, 'claude', '${sid}', 'local'); await window.__coralReady.agentSelected('${sid}'); return true; })()`);
                await waitFor(`document.querySelectorAll('#live-history-messages .message, #live-history-messages [data-msg-index], #live-history-messages .chat-bubble').length > 0 || /history answer/.test(document.getElementById('live-history-messages')?.textContent || '')`,
                    `${at}the history in the chat`, 15000).catch(async e => { throw new Error(`${e.message}; the pane: ${JSON.stringify(await ev(`(() => { const p = document.getElementById('live-history-messages'); return { text: p ? p.textContent.slice(0, 200) : null, wrapper: document.getElementById('capture-wrapper')?.className, composer: !document.getElementById('sleeping-composer')?.hidden }; })()`))}`); });
                const text = await ev(`document.getElementById('live-history-messages').textContent`);
                assert.match(text, /history answer 39/, `${at}the newest reply is shown`);
                assert.equal(await ev(`!!document.getElementById('sleeping-composer') && !document.getElementById('sleeping-composer').hidden`), true, `${at}the Wake/Restart bar is below it`);
                // scroll to the top: the earlier pages load
                await ev(`(async () => { const p = document.getElementById('live-history-messages'); const sc = p.closest('#chat-scroll, .chat-scroll') || p; for (let i = 0; i < 12; i++) { sc.scrollTop = 0; p.scrollTop = 0; await new Promise(r => setTimeout(r, 150)); } return true; })()`); // sleep-ok: each scroll to the top starts an older-page load
                await waitFor(`/history question 0\\b/.test(document.getElementById('live-history-messages').textContent)`, `${at}the oldest message after scrolling up`, 15000);
                console.log(`   ✓ ${at}the history shows, the bar is below it, and scrolling up reaches the first message`);
            }
        }
        // The operator's case (#136431): the transcript file is gone from disk (the CLI's own cleanup, a moved folder). The chat then says so in the words an empty chat has, with the bar below, not a blank pane.
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            for (const [sid, name, label, words] of [[GONE, 'Gone Ended', 'ended', /This agent has ended/], [GONE_SLEEPING, 'Gone Asleep', 'sleeping', /This agent is asleep/]]) {
                const at = `${w}px, ${label}, no transcript on disk: `;
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
                await waitFor(`(window._coralGetLiveSessions() || []).some(s => s.session_id === '${sid}')`, `${at}the row in the live list`, 15000);
                await ev(`(async () => { const row = document.querySelector('.session-group-item[data-session-id="${sid}"]'); if (row) row.click(); else window.selectLiveSession(${JSON.stringify(name)}, 'claude', '${sid}', 'local'); await window.__coralReady.agentSelected('${sid}'); return true; })()`);
                await waitFor(`!!document.querySelector('#live-history-messages > .chat-empty')`, `${at}the empty chat's words in the pane`, 8000).catch(async e => { throw new Error(`${e.message}; the pane: ${JSON.stringify(await ev(`(() => { const p = document.getElementById('live-history-messages'); const c = document.getElementById('capture-wrapper'); return { html: p ? p.innerHTML.slice(0, 300) : null, display: p ? getComputedStyle(p).display : null, wrapper: c && c.className, pane: p && p.getBoundingClientRect().height }; })()`))}`); });
                assert.match(await ev(`document.querySelector('#live-history-messages > .chat-empty').textContent`), words, `${at}it says what the agent is`);
                console.log(`   ✓ ${at}the pane says what the agent is, not blank`);
            }
        }
        console.log('PASS sleeping and ended agents show and scroll their chat history');
    } finally {
        try { db(`DELETE FROM live_sessions WHERE session_id IN ('${SLEEPING}', '${ENDED}', '${GONE}', '${GONE_SLEEPING}');`); } catch { /* gone */ }
        try { fs.rmSync(wd, { recursive: true, force: true }); fs.rmSync(projects, { recursive: true, force: true }); } catch { /* gone */ }
        await client.close();
    }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
