// The board table on a real-shaped board (#8047, goal #33): 2,100 messages over six days from fourteen senders (long ones with code blocks and tables, reply chains, mentions, asks, task tags, gaps where messages were
// deleted), posted through the real board API of the isolated server (the times then spread over the six days in its database), so paging, search (its FTS index) and the poll read the real server. The team Board at 1280 px
// (dark) and 390 px (light), then the dock's Board tab at 420 px: paging up loads the earlier days in order under their day lines, opening and closing a row keeps the scroll, a search counts and steps across
// collapsed rows (stepping opens the row), Expand all on a big day, live messages arriving while a row is open, and the memory after the whole board has been loaded (heap and nodes stay bounded).
// Drives Chrome over CDP against the isolated dev server; with CORAL_SCREENSHOT_DIR set it also saves a picture of each.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { sqliteExec } = require('./helpers/sqlite'); // the sqlite3 tool when there is one, else Node's own SQLite: a Windows machine has no sqlite3 (#8797)
const { removeBoards } = require('./helpers/board_cleanup');

const ftsCheck = (label) => { try { sqliteExec(require('node:path').join(process.env.CORAL_TEST_DATA_DIR, 'messageboard.db'), "PRAGMA busy_timeout=20000;\nINSERT INTO board_messages_fts(board_messages_fts, rank) VALUES('integrity-check', 1);"); console.log('FTSDIAG ok after ' + label); } catch (e) { console.log('FTSDIAG CORRUPT after ' + label + ': ' + String(e.message || e).split('\n')[0]); } };
const B = 'seeded-8047-' + (Date.now() % 100000);
const TOTAL = 2100, DAYS = 6, NEEDLE = 'zebra-needle';
const SENDERS = [['orchestrator', 'Orchestrator'], ['qa-1', 'QA Engineer'], ['be-1', 'Backend Dev'], ['fe-1', 'Frontend Dev'], ['fe-teams', 'Frontend Dev Teams UI'], ['sec-win', 'Security Reviewer Windows'],
    ['ds', 'Data Science & Dashboarding'], ['devops', 'DevOps Engineer'], ['uiux', 'UI/UX'], ['lead', 'Lead Developer'], ['codex', 'Codex Test'], ['qa-2', 'QA Reviewer 2'], ['ua', 'UI Accessibility'], ['operator', 'Operator']];
const now = Date.now(), STEP = (DAYS * 86400000) / TOTAL;
// The seeded timeline ends at most six hours after the local midnight: the newest 250 messages span 17.7 hours, so with it ending later (any run after 17:42) they all fell on today and the day-line check had one line to find (#8568).
const sinceMidnight = now - new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
const END = now - Math.max(0, sinceMidnight - 6 * 3600000);
const NEEDLE_AT = new Set([121, 703, 1507]); // by order of posting
const spec = (i) => {
    const [sid, title] = SENDERS[i % SENDERS.length];
    let content = `Update ${i} from ${title}: the work on the board continues and this line is only a sentence of ordinary length for its row.`;
    if (i % 17 === 0) content = `## Report ${i}\n\nA longer one with a block of code:\n\n\`\`\`go\nfunc main() {\n    fmt.Println("report ${i}")\n}\n\`\`\`\n\n| name | value |\n|------|-------|\n| a | ${i} |\n| b | ${i * 2} |\n\nAnd a closing paragraph that goes on for a while so that the open row is taller than a phone screen: ${'more words, '.repeat(30)}`;
    if (i % 11 === 0) content = `@Backend Dev and @QA Engineer please look at #${7100 + (i % 900)} when you can. ` + content;
    if (NEEDLE_AT.has(i)) content = `First line of ${i}, which does not say it.\n\nSecond paragraph, deeper in the text: ${NEEDLE} is here.`;
    const body = { subscriber_id: sid, content };
    if (i % 23 === 0) { body.content = `@${title === 'Backend Dev' ? 'QA Engineer' : 'Backend Dev'} ${content}`; body.ask = true; } // an ask names a member who is not the asker
    return body;
};

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation, Performance, HeapProfiler, Input } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
    const { waitFor, coralReady, settle } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const metrics = async () => { await HeapProfiler.collectGarbage(); await HeapProfiler.collectGarbage(); const m = Object.fromEntries((await Performance.getMetrics()).metrics.map(x => [x.name, x.value])); return { heap: m.JSHeapUsedSize / 1048576, nodes: m.Nodes }; };
    const log = (...a) => { console.log(...a); if (process.env.WALK_LOG) fs.appendFileSync(process.env.WALK_LOG, a.join(' ') + '\n'); };
    let box = `document.getElementById('mb-messages')`, rows = `${box}.querySelectorAll(':scope > .mb-message')`;
    const ids = () => ev(`[...${rows}].map(r => Number(r.dataset.messageId))`);
    const days = () => ev(`[...${box}.querySelectorAll(':scope > .mb-day')].map(d => d.dataset.day)`);
    const orderOk = async (what) => {
        const a = await ids();
        assert.ok(a.every((x, i) => i === 0 || x > a[i - 1]), `${what}: the rows are in order and each once: ${a.slice(0, 8)}...`);
        const d = (await days()).map(x => new Date(x).getTime());
        assert.ok(d.length >= 1 && d.every((x, i) => i === 0 || x > d[i - 1]), `${what}: the day lines are in order and each once: ${JSON.stringify(await days())}`);
    };
    const scrollTop = () => ev(`${box}.scrollTop`);
    const pagesUp = async (want) => { for (let guard = 0; guard < 40; guard++) { const n = (await ev(`window.__coral.boardCounts().shown`)); if (n >= want) return n; await ev(`${box}.scrollTop = 0; true`); await settle(250); } return ev(`window.__coral.boardCounts().shown`); };
    const theme = t => ev(`(async () => { const sc = await import(${S} + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme(${JSON.stringify(t)}); return true; })()`);
    const openBoard = async (w, h, mobile, t) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(); await theme(t);
        const loaded = Page.loadEventFired(); await Page.navigate({ url: `${BASE}/team/${B}/messages` }); await loaded; await coralReady();
        await waitFor(`window.__coral && window.__coral.boardCounts && window.__coral.boardCounts().shown >= 50 && document.querySelectorAll('#mb-messages > .mb-message').length >= 50`, 'the newest page', { timeout: 20000 });
        await settle(400);
    };
    try {
        await Promise.all([Page.enable(), Runtime.enable(), HeapProfiler.enable(), Performance.enable()]);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        for (const [sid, title] of SENDERS) await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: title, session_name: sid + '-s' });
        // 2,100 posts through the real board API (in order, a reply chain of two now and then), every 29th deleted again through the API, then the times of the survivors spread over six days in the board's own
        // database (the isolated server's: the API stamps "now"). Everything the page then reads comes from the real server.
        const seed = await ev(`(async () => {
            const specs = ${JSON.stringify(Array.from({ length: TOTAL }, (_, k) => spec(k + 1)))}; const ids = []; const bad = [];
            for (let k = 0; k < specs.length; k++) {
                const i = k + 1, body = { ...specs[k] };
                if ((i % 7 === 3 || i % 7 === 4) && ids[k - 1]) body.reply_to = ids[k - 1];
                const r = await fetch('/api/board/${B}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) { bad.push([i, r.status, JSON.stringify(j).slice(0, 120)]); ids.push(null); continue; }
                ids.push(j.id || (j.message && j.message.id));
            }
            return { ids, bad: bad.slice(0, 5), nbad: bad.length }; })()`);
        ftsCheck('the posts');
        assert.equal(seed.nbad, 0, 'every post was accepted: ' + JSON.stringify(seed.bad));
        const postedIds = seed.ids;
        assert.ok(postedIds.every(Number.isInteger), 'every post has an id');
        const deleted = new Set();
        for (let i = 29; i <= TOTAL; i += 29) { const st = await ev(`fetch('/api/board/${B}/messages/${postedIds[i - 1]}', { method: 'DELETE' }).then(r => r.status)`); assert.ok(st < 300, 'deleting message ' + i + ': ' + st); deleted.add(i); }
        ftsCheck('the deletes');
        const dataDir = process.env.CORAL_TEST_DATA_DIR;
        assert.ok(dataDir, 'the runner gives the isolated data directory (CORAL_TEST_DATA_DIR)');
        const stamp = i => new Date(END - (TOTAL - i) * STEP).toISOString();
        const sql = ['PRAGMA busy_timeout=20000;', 'BEGIN;', ...postedIds.map((id, k) => `UPDATE board_messages SET created_at='${stamp(k + 1)}' WHERE id=${id};`), 'COMMIT;'].join('\n');
        sqliteExec(require('node:path').join(dataDir, 'messageboard.db'), sql);
        ftsCheck('the timestamp UPDATE');
        const kept = postedIds.filter((id, k) => !deleted.has(k + 1));
        const TOTAL_LEFT = kept.length;
        const needleIds = [...NEEDLE_AT].map(i => postedIds[i - 1]).sort((a, b) => b - a);
        log(`seeded ${TOTAL_LEFT} messages (${deleted.size} deleted again) over ${DAYS} days through the real API`);
        for (const [label, w, h, mobile, t] of [['1280 dark', 1280, 800, false, 'dark'], ['390 light', 390, 844, true, 'light']]) {
            const tag = label.replace(' ', '-');
            log(`${label}: the newest page, paging up loads the earlier days in order`);
            await openBoard(w, h, mobile, t);
            const base = await metrics();
            assert.equal(await ev(`window.__coral.boardCounts().shown`), 50);
            await orderOk('the newest page');
            await shot(`seeded-${tag}-newest`);
            const n = await pagesUp(250);
            assert.ok(n >= 250, `five pages up: ${n} shown`);
            await orderOk('after paging up');
            assert.ok((await days()).length >= 2, 'more than one day line after paging up: ' + JSON.stringify(await days()));
            await shot(`seeded-${tag}-paged`);

            log(`${label}: opening and closing a row keeps the scroll`);
            const mid = await ev(`(() => { const b = ${box}; b.scrollTop = Math.round((b.scrollHeight - b.clientHeight) / 2); const r = [...${rows}].find(x => x.getBoundingClientRect().top > b.getBoundingClientRect().top + 40 && x.classList.contains('mb-q') === false) || ${box}.querySelector('.mb-message'); return { id: r.dataset.messageId, top: Math.round(r.getBoundingClientRect().top), st: b.scrollTop }; })()`);
            await settle(300);
            for (const want of ['open', 'closed']) {
                await ev(`${box}.querySelector('.mb-message[data-message-id="${mid.id}"] > .mb-row-toggle').click(); true`); await settle(200);
                const after = await ev(`(() => { const r = ${box}.querySelector('.mb-message[data-message-id="${mid.id}"]'); return { top: Math.round(r.getBoundingClientRect().top), st: ${box}.scrollTop, open: r.classList.contains('mb-open') }; })()`);
                assert.equal(after.open, want === 'open', `the row is ${want}`);
                assert.ok(Math.abs(after.top - mid.top) <= 1 && Math.abs(after.st - mid.st) <= 1, `${want}: the row and the scroll stay (${mid.top} -> ${after.top}, ${mid.st} -> ${after.st})`);
            }

            log(`${label}: a search counts and steps across collapsed rows`);
            await ev(`document.querySelector('#bm-search').focus(); true`); await Input.insertText({ text: NEEDLE });
            await waitFor(`/^1 of 3 matches$/.test((document.querySelector('#mb-tools .mb-search-results') || {}).textContent || '')`, 'three matches counted', { timeout: 8000 });
            await waitFor(`!!document.querySelector('#mb-messages > .mb-message.mb-message-current')`, 'the current match', { timeout: 8000 }); await settle(400);
            const cur = async () => ev(`(() => { const r = document.querySelector('#mb-messages > .mb-message.mb-message-current'); if (!r) return null; const b = r.querySelector('.mb-message-body').getBoundingClientRect(); const c = ${box}.getBoundingClientRect(); return { id: Number(r.dataset.messageId), open: r.classList.contains('mb-open'), expanded: r.querySelector('.mb-row-toggle').getAttribute('aria-expanded'), inView: b.height > 0 && r.getBoundingClientRect().top >= c.top - 1 && r.getBoundingClientRect().top < c.bottom - 40, marks: r.querySelectorAll('mark.mb-hit').length }; })()`);
            const seen = [];
            const visible = `(() => { const r = document.querySelector('#mb-messages > .mb-message.mb-message-current'); if (!r) return false; const c = ${box}.getBoundingClientRect(), t = r.getBoundingClientRect().top; return t >= c.top - 1 && t < c.bottom - 40; })()`;
            for (let i = 0; i < 3; i++) {
                const t0 = Date.now(); let landed = true;
                await waitFor(visible, `match ${i + 1} on screen`, { timeout: 8000 }).catch(() => { landed = false; });
                log(`   match ${i + 1}: ${landed ? 'on screen after ' + (Date.now() - t0) + ' ms' : 'NOT on screen after 8 s: ' + JSON.stringify(await ev(`(() => { const r = document.querySelector('#mb-messages > .mb-message.mb-message-current'); const c = ${box}.getBoundingClientRect(); return r ? { top: Math.round(r.getBoundingClientRect().top - c.top), box: Math.round(c.height), st: ${box}.scrollTop, sh: ${box}.scrollHeight } : null; })()`))}`);
                const c = await cur();
                assert.ok(c && c.open && c.expanded === 'true' && c.marks === 1 && c.inView, `match ${i + 1} is open and marked: ${JSON.stringify(c)}`);
                seen.push(c.id);
                if (i < 2) { await ev(`document.querySelector('.mb-search-step[data-step=older]').click(); true`); await waitFor(`document.querySelector('#mb-tools .mb-search-results').textContent.startsWith('${i + 2} of ')`, `match ${i + 2}`, { timeout: 8000 }); await waitFor(`Number((document.querySelector('#mb-messages > .mb-message.mb-message-current') || { dataset: {} }).dataset.messageId) === ${needleIds[i + 1]}`, `the row of match ${i + 2}, its pages loaded`, { timeout: 20000 }); await settle(400); }
            }
            assert.deepEqual(seen, needleIds, 'the matches are stepped newest to oldest, across the pages between');
            assert.equal(await ev(`${box}.querySelectorAll(':scope > .mb-message.mb-open').length`) >= 1, true);
            await shot(`seeded-${tag}-search`);
            await ev(`document.querySelector('#mb-tools .mb-search-clear').click(); true`); await settle(300);

            log(`${label}: Expand all on a big day`);
            const before = await metrics();
            const t0 = Date.now();
            await ev(`(() => { const b = document.querySelector('#mb-tools .list-bar-more-btn'); b.click(); return true; })()`); await settle(150);
            await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].find(x => x.textContent.trim() === 'Expand all').click(); true`);
            await waitFor(`[...${rows}].every(r => r.classList.contains('mb-open'))`, 'every loaded row open', { timeout: 20000 });
            const took = Date.now() - t0, shown = await ev(`${rows}.length`);
            const big = await metrics();
            log('   expand all: ' + shown + ' rows in ' + took + ' ms, +' + (big.nodes - before.nodes) + ' nodes, heap ' + before.heap.toFixed(1) + ' -> ' + big.heap.toFixed(1) + ' MB');
            assert.ok(took < 6000, `Expand all on ${shown} rows took ${took} ms`);
            assert.ok(big.nodes - before.nodes < 120000, `Expand all adds ${big.nodes - before.nodes} nodes for ${shown} rows`);
            await ev(`${box}.scrollTop = ${box}.scrollHeight; true`); await settle(300); await shot(`seeded-${tag}-expanded`);
            await ev(`document.querySelector('#mb-tools .list-bar-more-btn').click(); true`); await settle(150);
            await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].find(x => x.textContent.trim() === 'Collapse all').click(); true`);
            await waitFor(`[...${rows}].every(r => !r.classList.contains('mb-open'))`, 'every row closed', { timeout: 20000 });

            log(`${label}: live messages arrive while a row is open`);
            await ev(`${box}.scrollTop = ${box}.scrollHeight; true`); await settle(300);
            const lastBefore = (await ids()).at(-1);
            await ev(`${box}.querySelector('.mb-message:last-of-type > .mb-row-toggle, .mb-message:nth-last-child(1) > .mb-row-toggle')?.click(); true`);
            const openId = await ev(`(() => { const o = ${box}.querySelector(':scope > .mb-message.mb-open'); return o ? Number(o.dataset.messageId) : null; })()`);
            assert.ok(openId, 'a row at the bottom is open');
            const newIds = []; for (let k = 0; k < 3; k++) newIds.push(await ev(`fetch('/api/board/${B}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orchestrator', content: 'A live message ${k} while a row is open.' }) }).then(r => r.json()).then(j => j.id || j.message.id)`));
            await waitFor(`${box}.querySelector(':scope > .mb-message[data-message-id="${newIds[2]}"]')`, 'the live messages', { timeout: 25000 });
            const live = await ev(`(() => ({ open: ${box}.querySelector(':scope > .mb-message[data-message-id="${openId}"]')?.classList.contains('mb-open'), newOpen: ${box}.querySelectorAll(':scope > .mb-message[data-message-id="${newIds[0]}"].mb-open, :scope > .mb-message[data-message-id="${newIds[2]}"].mb-open').length, last: Number(${box}.querySelector(':scope > .mb-message:last-of-type')?.dataset.messageId) }))()`);
            assert.ok(live.open && live.newOpen === 0 && live.last === newIds[2], `the open row stayed open and the new ones are closed rows at the bottom: ${JSON.stringify(live)} (last was ${lastBefore})`);
            await orderOk('after live messages');

            log(`${label}: the memory after the whole board has been loaded`);
            await ev(`document.querySelector('#mb-tools .list-bar-more-btn').click(); true`); await settle(150);
            await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].find(x => /Jump to first/.test(x.textContent)).click(); true`);
            await waitFor(`window.__coral.boardCounts().notLoaded === 0`, 'every page loaded', { timeout: 120000 });
            await orderOk('the whole board');
            const full = await metrics();
            const count = await ev(`window.__coral.boardCounts().shown`);
            log(`   ${count} rows: heap ${base.heap.toFixed(1)} -> ${full.heap.toFixed(1)} MB, nodes ${base.nodes} -> ${full.nodes}`);
            { const b4 = await metrics(), t1 = Date.now();
              await ev(`document.querySelector('#mb-tools .list-bar-more-btn').click(); true`); await settle(150);
              await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].find(x => x.textContent.trim() === 'Expand all').click(); true`);
              await waitFor(`[...${rows}].every(r => r.classList.contains('mb-open'))`, 'every row of the whole board open', { timeout: 60000 });
              const ms = Date.now() - t1, bx = await metrics();
              log('   expand all on the whole board: ' + count + ' rows in ' + ms + ' ms, +' + (bx.nodes - b4.nodes) + ' nodes, heap ' + b4.heap.toFixed(1) + ' -> ' + bx.heap.toFixed(1) + ' MB');
              assert.ok(ms < 20000 && bx.heap - b4.heap < 200, 'Expand all on the whole board: ' + ms + ' ms, +' + (bx.heap - b4.heap).toFixed(1) + ' MB');
              await ev(`document.querySelector('#mb-tools .list-bar-more-btn').click(); true`); await settle(150);
              await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].find(x => x.textContent.trim() === 'Collapse all').click(); true`);
              await waitFor(`[...${rows}].every(r => !r.classList.contains('mb-open'))`, 'the whole board closed', { timeout: 60000 }); }
            await ev(`document.querySelector('#mb-tools .list-bar-more-btn').click(); true`); await settle(150);
            await ev(`[...document.querySelectorAll('#mb-tools .list-bar-more-menu [role=menuitem]')].find(x => /Jump to latest/.test(x.textContent)).click(); true`); await settle(500);
            const latest = await metrics();
            assert.ok(full.heap - base.heap < 150, `${count} loaded rows: the heap grew ${(full.heap - base.heap).toFixed(1)} MB`);
            assert.ok(latest.heap - base.heap < 150, `back at the latest: the heap is ${(latest.heap - base.heap).toFixed(1)} MB over where it started`);
            await shot(`seeded-${tag}-latest`);
        }

        // ── the agent dock's Board tab, on the same board ──
        const DB = `document.getElementById('board-panel-msgs')`, drows = `${DB}.querySelectorAll(':scope > .mb-message')`;
        const dorder = async (what) => {
            const a = await ev(`[...${drows}].map(r => Number(r.dataset.messageId))`);
            assert.ok(a.every((x, i) => i === 0 || x > a[i - 1]), `${what}: the dock's rows are in order and each once`);
            const d = (await ev(`[...${DB}.querySelectorAll(':scope > .mb-day')].map(x => x.dataset.day)`)).map(x => new Date(x).getTime());
            assert.ok(d.every((x, i) => i === 0 || x > d[i - 1]), `${what}: the dock's day lines are in order and each once`);
            return a;
        };
        for (const [label, w, h, mobile, t, dockPx] of [['dock 420 dark', 1280, 800, false, 'dark', 420], ['dock 390 light', 390, 844, true, 'light', 390]]) {
            const tag = label.replace(/ /g, '-');
            log(`${label}: paging up, opening a row, live messages, memory`);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(); await theme(t);
            await ev(`(async () => { const st = window.__coralStatic || '/static/'; const av = document.getElementById('live-session-view'); if (av) av.style.display = '';
                let p = document.getElementById('agentic-panel-board'); if (!p) { p = document.createElement('div'); p.id = 'agentic-panel-board'; document.body.appendChild(p); }
                document.body.appendChild(p); p.classList.add('active'); p.hidden = false; p.style.cssText = 'display:flex;flex-direction:column;position:fixed;top:0;right:0;bottom:0;width:${dockPx}px;z-index:50;background:var(--bg-primary)';
                const m = await import(st + 'render.js'); m.showBoardChatTab(${JSON.stringify(B)}); return true; })()`);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length >= 50`, 'the dock rows', { timeout: 20000 }); await settle(400);
            const d0 = await metrics();
            await dorder('the newest page'); await shot(`seeded-${tag}-newest`);
            for (let guard = 0, n = 0; guard < 30; guard++) { n = await ev(`window.__coral.boardChatCounts ? window.__coral.boardChatCounts().shown : ${drows}.length`); if (n >= 250) break; await ev(`${DB}.scrollTop = 0; true`); await settle(300); }
            const nd = await ev(`${drows}.length`);
            assert.ok(nd >= 250, `the dock paged up: ${nd} rows`);
            await dorder('after paging up'); await shot(`seeded-${tag}-paged`);
            const dm = await ev(`(() => { const b = ${DB}; b.scrollTop = Math.round((b.scrollHeight - b.clientHeight) / 2); const r = [...${drows}].find(x => x.getBoundingClientRect().top > b.getBoundingClientRect().top + 40); return { id: r.dataset.messageId, top: Math.round(r.getBoundingClientRect().top), st: b.scrollTop }; })()`); await settle(300);
            for (const want of ['open', 'closed']) {
                await ev(`${DB}.querySelector('.mb-message[data-message-id="${dm.id}"] > .mb-row-toggle').click(); true`); await settle(200);
                const af = await ev(`(() => { const r = ${DB}.querySelector('.mb-message[data-message-id="${dm.id}"]'); return { top: Math.round(r.getBoundingClientRect().top), st: ${DB}.scrollTop, open: r.classList.contains('mb-open') }; })()`);
                assert.equal(af.open, want === 'open', `the dock row is ${want}`);
                assert.ok(Math.abs(af.top - dm.top) <= 1 && Math.abs(af.st - dm.st) <= 1, `${want}: the dock row and its scroll stay (${dm.top} -> ${af.top}, ${dm.st} -> ${af.st})`);
            }
            await ev(`${DB}.scrollTop = ${DB}.scrollHeight; true`); await settle(300);
            await ev(`${DB}.querySelector(':scope > .mb-message:last-of-type > .mb-row-toggle')?.click(); true`);
            const dOpen = await ev(`(() => { const o = ${DB}.querySelector(':scope > .mb-message.mb-open'); return o ? Number(o.dataset.messageId) : null; })()`);
            assert.ok(dOpen, 'a dock row at the bottom is open');
            const dNew = await ev(`fetch('/api/board/${B}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orchestrator', content: 'A live message for the dock while a row is open.' }) }).then(r => r.json()).then(j => j.id || j.message.id)`);
            await waitFor(`${DB}.querySelector(':scope > .mb-message[data-message-id="${dNew}"]')`, 'the live message in the dock', { timeout: 20000 });
            assert.ok(await ev(`${DB}.querySelector(':scope > .mb-message[data-message-id="${dOpen}"]').classList.contains('mb-open') && !${DB}.querySelector(':scope > .mb-message[data-message-id="${dNew}"]').classList.contains('mb-open')`), 'the open dock row stayed open; the new one is a closed row');
            await dorder('after a live message');
            for (let k = 0; k < 12; k++) { await ev(`${DB}.scrollTop = 0; true`); await settle(250); await ev(`${DB}.scrollTop = ${DB}.scrollHeight; true`); await settle(150); }
            const d1 = await metrics();
            const nAfter = await ev(`${drows}.length`);
            log(`   dock ${nAfter} rows after scrolling the board up and down 12 times: heap ${d0.heap.toFixed(1)} -> ${d1.heap.toFixed(1)} MB, nodes ${d0.nodes} -> ${d1.nodes}`);
            assert.ok(d1.heap - d0.heap < 150, `the dock's heap grew ${(d1.heap - d0.heap).toFixed(1)} MB`);
            await shot(`seeded-${tag}-end`);
        }
        console.log('PASS the board table on a real-shaped board');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
