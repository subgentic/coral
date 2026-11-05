// Automations > Queue, the history of the runs, against a REAL isolated server with REAL claims (#13724): no stubbed read. A resource is defined, four agents are subscribed to a throwaway board and claim, wait, release,
// leave the line and are kicked through the routes the CLI uses; the page then reads real rows from resource_history.db: who, how long each waited and held, how each ended, newest first; a filter, the server's search by
// how a run ended, and the route's own answer are checked against what was done. Shots at 1280 and 390 in both themes when CORAL_SCREENSHOT_DIR is set. (The stubbed suite, automations_queue_history_browser,
// covers paging, races and failures.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const { sqliteExec } = require('./helpers/sqlite');
const path = require('node:path');
const DATA = process.env.CORAL_TEST_DATA_DIR;
const TAG = Date.now() % 100000, B = 'queue-history-real-' + TAG, R = 'hist-real-' + TAG;
const AGENTS = ['History Agent A', 'History Agent B', 'History Agent C', 'History Agent D', 'History Agent E', 'History Agent F'];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    assert.ok(DATA, 'run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)');
    const KEY = fs.readFileSync(path.join(DATA, 'api_key'), 'utf8').trim();
    // the seeding is the Operator's own commands, as the CLI sends them (the isolated server's API key); the PAGE's reads below are the page's own
    const api = async (m, p, body) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const pageApi = (m, p) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const pause = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a real wait in line, so the history has a wait to show
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await pause(500); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const claim = async who => api('POST', `/api/resources/${R}/claim`, { subscriber_id: who });
    const release = async who => api('POST', `/api/resources/${R}/release`, { subscriber_id: who });
    const entryOf = async who => { const l = await api('GET', `/api/resources/${R}`); const r = l.body && (l.body.resource || l.body); const all = [...(r.holders || []), ...(r.queue || [])]; const e = all.find(x => x.agent === who); return e && e.id; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        for (const a of AGENTS) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: a, job_title: 'Dev', session_name: 'claude-' + a.replace(/\W/g, '-') })).status, 200, 'subscribed ' + a);
        const def = await api('PUT', `/api/resources/${R}`, { slots: 1, machine: 'Test Mac' });
        assert.ok([200, 201].includes(def.status), 'the resource is defined: ' + def.status + ' ' + JSON.stringify(def.body));

        // the real sequence on one slot
        assert.equal((await claim(AGENTS[0])).body.granted, true, 'A holds the slot');
        assert.equal((await claim(AGENTS[1])).body.granted, false, 'B waits behind A');
        await pause(2200); // sleep-ok: B waits about two seconds in line, so the history has a real wait to show
        await release(AGENTS[0]); // B is granted after waiting about 2 s
        await pause(1200); // sleep-ok: B holds about a second, so the history has a real hold to show
        await release(AGENTS[1]); // B held about 1 s
        assert.equal((await claim(AGENTS[2])).body.granted, true, 'C holds');
        await claim(AGENTS[3]); // D waits
        await claim(AGENTS[4]); // E waits
        await release(AGENTS[4]); // E leaves the line itself
        await api('DELETE', `/api/resources/entries/${await entryOf(AGENTS[3])}`); // D is kicked out of the line
        await release(AGENTS[2]); // C releases
        assert.equal((await claim(AGENTS[5])).body.granted, true, 'F holds');
        await api('DELETE', `/api/resources/entries/${await entryOf(AGENTS[5])}`); // F, a holder, is kicked

        // the route's own answer, from the real record
        const r = await pageApi('GET', `/api/analytics/resource-queue/runs?resource=${R}`); // the page's own read: the Operator's dashboard is let in
        assert.equal(r.status, 200, 'the route answers the Operator: ' + JSON.stringify(r.body).slice(0, 200));
        assert.equal(r.body.history, true);
        const ends = r.body.runs.map(x => [x.agent.replace('History Agent ', ''), x.end]);
        assert.equal(ends.length, 6, JSON.stringify(ends));
        assert.deepEqual([ends[0], ends[1], ends[4], ends[5]], [['F', 'kicked'], ['C', 'released'], ['B', 'released'], ['A', 'released']], 'newest first: ' + JSON.stringify(ends));
        assert.deepEqual(new Set(ends.slice(2, 4).map(x => x.join(':'))), new Set(['D:kicked_from_line', 'E:left_line']), 'D was kicked out of the line and E left it');
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`history.pushState(null, '', '/automations/queue'); window.dispatchEvent(new PopStateEvent('popstate')); true`);
        const rows = `document.querySelectorAll('.qh-section tbody tr[data-key]')`;
        await waitFor(`[...${rows}].filter(r => /History Agent/.test(r.textContent)).length >= 6`, 'the six real runs on the page', 15000);
        const text = await ev(`[...${rows}].filter(r => /History Agent/.test(r.textContent)).map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
        const find = who => text.find(t => t.includes(`History Agent ${who}`));
        assert.match(find('A'), /Released/); assert.match(find('B'), /Released/); assert.match(find('C'), /Released/);
        assert.match(find('D'), /Kicked from the line/); assert.match(find('E'), /Left the line/); assert.match(find('F'), /Kicked/);
        assert.match(find('B'), /2 s|3 s/, 'B waited about two seconds in line: ' + find('B'));
        assert.ok(!/Released/.test(find('F')) && !/from the line/.test(find('F')), 'F was a holder that was kicked, not a place');
        assert.ok(await ev(`[...${rows}].filter(r => /History Agent/.test(r.textContent)).every(r => /Test Mac|hist-real/.test(r.textContent))`), 'each row names the resource');
        await shot('queue-history-real-dark-1280');
        // a filter and the server's search by how a run ended
        await ev(`{ const s = [...document.querySelectorAll('.qh-filter')].find(x => x.getAttribute('aria-label') === 'Agent'); s.value = 'History Agent B'; s.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        await waitFor(`[...${rows}].filter(r => /History Agent/.test(r.textContent)).length === 1 && /History Agent B/.test(document.querySelector('.qh-section').textContent)`, 'only B', 8000);
        await ev(`{ const s = [...document.querySelectorAll('.qh-filter')].find(x => x.getAttribute('aria-label') === 'Agent'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        await ev(`(() => { const i = document.getElementById('automations-search'); i.value = 'kicked'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`[...${rows}].filter(r => /History Agent/.test(r.textContent)).length === 2`, 'the two kicked runs by search: ' + JSON.stringify(await ev(`[...${rows}].map(r => r.textContent.slice(0, 60))`)), 10000);
        await ev(`(() => { const i = document.getElementById('automations-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`[...${rows}].filter(r => /History Agent/.test(r.textContent)).length >= 6`, 'cleared', 10000);
        // light theme and a phone
        await ev(`document.documentElement.setAttribute('data-theme', 'light'); true`); await shot('queue-history-real-light-1280');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await waitFor(`[...${rows}].filter(r => /History Agent/.test(r.textContent)).length >= 6`, 'the rows on a phone', 10000);
        assert.ok(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no sideways scroll on a phone');
        await shot('queue-history-real-light-390');
        await ev(`document.documentElement.setAttribute('data-theme', 'dark'); true`); await shot('queue-history-real-dark-390');
        console.log('PASS queue history on a real server: real claims, waits, holds, kicks and departures read back, filtered and searched, at 1280 and 390');
    } finally {
        try { await api('DELETE', `/api/resources/${R}`); } catch { /* none */ }
        try { sqliteExec(path.join(DATA, 'resource_history.db'), `PRAGMA busy_timeout=20000; DELETE FROM resource_events WHERE resource = '${R}';`); } catch { /* the record was not made */ } // the rows this run made: another suite of this server counts the page's rows
        await removeBoards(ev, [B]).catch(() => {});
        await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
