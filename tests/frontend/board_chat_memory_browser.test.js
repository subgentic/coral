// #4318 (UX's #4276 audit): an idle agent page on a busy board grew its JS heap from 6.6 MB to
// 109 MB in 10 minutes, accelerating, with the DOM +1,600 nodes a minute. Two causes:
//   - morphHtml kept each top-level part's source as a slice of the markup it came from, and in V8
//     a slice keeps the whole string alive: a list that grows a node at a time (the board panel)
//     held one copy of its full markup per update. 40 MB of strings in 6 minutes.
//   - the board panel kept every message it ever received, and re-templated all of them for each
//     new one.
// Here: (A) morphing a list that grows by one node, 400 times, retains about the list itself after
// a GC, not hundreds of copies of it; (B) the board panel fed 1,200 messages, 20 per load, keeps a
// window of the newest (the rest behind "Load earlier", which counts them), and its heap and DOM
// stay bounded. The board's replies come from a stub of its /messages/all route.
'use strict';

const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

const results = [];
const check = (label, ok, detail) => { results.push(!!ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, HeapProfiler, Performance } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic||'/static/')`;
    const heapMB = async () => {
        await HeapProfiler.collectGarbage(); await HeapProfiler.collectGarbage();
        const m = Object.fromEntries((await Performance.getMetrics()).metrics.map(x => [x.name, x.value]));
        return { heap: m.JSHeapUsedSize / 1048576, nodes: m.Nodes };
    };

    try {
        await Promise.all([Page.enable(), Runtime.enable(), HeapProfiler.enable(), Performance.enable()]);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await coralReady();

        // ── (A) morphHtml on a list growing one node at a time ─────────────
        await ev(`(async () => {
            const morph = await import(${S} + 'dom_morph.js');
            const box = document.createElement('div'); box.id = 'morph-4318'; document.body.appendChild(box);
            const pad = 'x'.repeat(600);
            window.__grow = n => { let h = ''; for (let i = 0; i < n; i++) h += '<div class="m" data-i="' + i + '">message ' + i + ' ' + pad + '</div>'; morph.morphHtml(box, h); };
            return true;
        })()`);
        const a0 = await heapMB();
        await ev(`(() => { for (let n = 1; n <= 400; n++) window.__grow(n); return document.getElementById('morph-4318').children.length; })()`);
        const a1 = await heapMB();
        const retainedA = a1.heap - a0.heap;
        // The final list is 400 x ~640 B = 0.25 MB of markup (its nodes and parts a few times that);
        // the old slices kept every update's full markup: about 400 x 400 / 2 x 640 B = 50 MB.
        check('(A) a list morphed 400 times, one node more each time, retains a few MB at most after GC', retainedA < 8,
            `${retainedA.toFixed(1)} MB retained (${a0.heap.toFixed(1)} -> ${a1.heap.toFixed(1)} MB)`);
        await ev(`(async () => { const morph = await import(${S} + 'dom_morph.js'); const b = document.getElementById('morph-4318'); morph.resetMorph(b); b.remove(); delete window.__grow; return true; })()`);

        // ── (B) the board panel on a busy board ────────────────────────────
        const board = `mem-4318-${Date.now()}`;
        await ev(`(() => {
            // The board: total messages so far, each ~300 characters; replies as the Go route gives them.
            const board = ${JSON.stringify(board)};
            const st = window.__board4318 = { total: 0 };
            const msg = id => ({ id, project: board, subscriber_id: 'agent-' + (id % 7), job_title: 'Agent ' + (id % 7), session_id: '', content: 'Message ' + id + ': ' + 'the handler reads the cache, then writes it back. '.repeat(6), created_at: new Date(1800000000000 + id * 1000).toISOString() });
            const range = (lo, hi) => { const out = []; for (let id = lo; id <= hi; id++) out.push(msg(id)); return out; };
            const realFetch = window.fetch;
            window.fetch = (input, init) => {
                const url = String(typeof input === 'string' ? input : input.url);
                if (!url.includes('/api/board/' + board + '/')) return realFetch(input, init);
                const u = new URL(url, location.href), q = u.searchParams;
                let body = { messages: [], total: st.total };
                if (u.pathname.endsWith('/messages/all')) {
                    const limit = Number(q.get('limit') || 50);
                    if (q.has('after_id')) body.messages = range(Number(q.get('after_id')) + 1, Math.min(st.total, Number(q.get('after_id')) + limit));
                    else if (q.has('before_id')) { const hi = Number(q.get('before_id')) - 1, lo = Math.max(1, hi - limit + 1); body.messages = range(lo, hi); body.before_count = lo - 1; }
                    else { const lo = Math.max(1, st.total - limit + 1); body.messages = range(lo, st.total); body.before_count = lo - 1; }
                }
                return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            };
            const agentView = document.getElementById('live-session-view');
            if (agentView) agentView.style.display = '';
            if (!document.getElementById('agentic-panel-board')) { const p = document.createElement('div'); p.id = 'agentic-panel-board'; document.body.appendChild(p); }
            return true;
        })()`);
        const shown = `document.querySelectorAll('#board-panel-msgs .mb-message').length`;
        // Each showBoardChatTab of the same board runs one load at once (the panel is kept): 20 new messages per load.
        const feed = async loads => {
            for (let k = 0; k < loads; k++) {
                const want = await ev(`(async () => { const st = window.__board4318; st.total += 20; const m = await import(${S} + 'render.js'); m.showBoardChatTab(${JSON.stringify(board)}); return st.total; })()`);
                await waitFor(`(() => { const last = [...document.querySelectorAll('#board-panel-msgs .mb-message-body')].at(-1); return !!last && last.textContent.startsWith('Message ' + window.__board4318.total + ':'); })()`, `message ${want} shown`, { timeout: 5000, soft: true });
            }
        };
        await feed(3); // 60 messages: the first page and two loads after it
        const b0 = await heapMB();
        await feed(57); // 1,200 in all
        const b1 = await heapMB();
        const n = await ev(shown);
        const total = await ev(`window.__board4318.total`);
        check('(B) the panel received every message up to the newest', total === 1200 && (await ev(`[...document.querySelectorAll('#board-panel-msgs .mb-message-body')].at(-1)?.textContent.startsWith('Message 1200:')`)), String(total));
        check('(B) it keeps a window of the newest messages, not all 1,200', n >= 300 && n <= 350, `${n} shown`);
        const counts = await ev(`window.__coral.boardChatCounts()`);
        check('(B) the rest are not loaded, and the panel has no "Load earlier" button or count (#7762)', counts.notLoaded === 1200 - n && (await ev(`document.querySelectorAll('#board-panel-msgs [data-on-click="board-chat-earlier"], #board-panel-msgs .mb-load-earlier').length`)) === 0 && !(await ev(`document.getElementById('board-panel-msgs').textContent`)).match(/Load \d+ earlier|remaining\)/), JSON.stringify(counts));
        check('(B) its DOM stays bounded while 1,140 more messages arrive', b1.nodes - b0.nodes < 8000, `${b0.nodes} -> ${b1.nodes} nodes`);
        check('(B) and so does its heap', b1.heap - b0.heap < 10, `${b0.heap.toFixed(1)} -> ${b1.heap.toFixed(1)} MB`);

        // Scrolled up, the reader's messages are not cut from under them.
        // (A hidden panel has no scroll position and counts as at the bottom: shown here, on top of the page.)
        const scrolls = await ev(`(() => { const p = document.getElementById('agentic-panel-board'); document.body.appendChild(p);
            p.style.cssText = 'display:block;position:fixed;left:0;top:0;width:420px;height:320px;z-index:99999;background:#fff';
            const el = document.getElementById('board-panel-msgs'); el.parentElement.style.height = '200px'; el.style.overflow = 'auto'; // the list's wrapper is what the panel's column gives its height to (#7762) el.scrollTop = 150; // reading higher up, but not at the very top: the top loads earlier messages (#7762)
            return el.scrollHeight > el.clientHeight; })()`);
        check('(B) the shown panel scrolls', scrolls);
        // Fed by the panel's own poll (every 3 s): showing the tab again would scroll it to the bottom.
        const before = await ev(shown);
        for (let k = 0; k < 3; k++) {
            await ev(`(window.__board4318.total += 20, true)`);
            await waitFor(`(() => { const last = [...document.querySelectorAll('#board-panel-msgs .mb-message-body')].at(-1); return !!last && last.textContent.startsWith('Message ' + window.__board4318.total + ':'); })()`, 'the poll brings them', { timeout: 10000, soft: true });        }
        const after = await ev(shown);
        const top = await ev(`document.getElementById('board-panel-msgs').scrollTop`);
        check('(B) scrolled up, new messages are added and none is dropped', after === before + 60 && top < 50, `${before} -> ${after}, scrollTop ${top}`);

        // Scrolling to the top brings older ones back by itself (#7762): no button; "Loading earlier messages..." floats over the list while it loads, the row at the top stays put, a screen reader is told.
        await ev(`new Promise(r => { document.getElementById('board-panel-msgs').scrollTop = 300; setTimeout(() => r(true), 150); })`); // away from the top first: a scroll event needs a change
        const row0 = await ev(`(() => { const el = document.getElementById('board-panel-msgs'); el.scrollTop = 0; const r = el.querySelector('.mb-message'); return { id: r.querySelector('.mb-message-body').textContent.slice(0, 14), y: r.getBoundingClientRect().top }; })()`); // at the top: the scroll event, and the load, come after this read
        await waitFor(`${shown} === ${after + 50}`, 'an earlier page', { timeout: 5000, soft: true });
        check('(B) scrolling to the top brings back a page of the older messages', (await ev(shown)) === after + 50, String(await ev(shown)));
        const row1 = await ev(`(() => { const r = [...document.querySelectorAll('#board-panel-msgs .mb-message')].find(x => x.querySelector('.mb-message-body').textContent.startsWith(${JSON.stringify(row0.id)})); return r ? r.getBoundingClientRect().top : null; })()`);
        check('(B) the row that was at the top stays where it was', row1 !== null && Math.abs(row1 - row0.y) < 40, `${row0.y} -> ${row1}`);
        check('(B) a screen reader hears it, and the loading line is gone', (await ev(`document.getElementById('board-chat-earlier-status').textContent`)) === '50 earlier messages loaded.' && (await ev(`document.getElementById('board-chat-loading').hidden`)) === true);
        // the floating "Loading earlier messages..." (the board's and the panel's one class) reads at 4.5:1 or more in both themes (computed style: a hidden element has one)
        const contrast = await ev(`(() => {
            const lum = c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
            const out = {}; const html = document.documentElement; const was = html.getAttribute('data-theme');
            for (const t of ['dark', 'light']) { html.setAttribute('data-theme', t); const cs = getComputedStyle(document.getElementById('board-chat-loading')); const a = lum(cs.color), b = lum(cs.backgroundColor); out[t] = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
            if (was === null) html.removeAttribute('data-theme'); else html.setAttribute('data-theme', was);
            return out; })()`);
        check('(B) the loading line has 4.5:1 contrast in both themes', contrast.dark >= 4.5 && contrast.light >= 4.5, JSON.stringify(contrast));
        check('(B) the panel has no count line either', (await ev(`document.querySelectorAll('#board-panel-msgs .mb-message-count').length`)) === 0);
    } catch (e) {
        check('no exception', false, e.message);
    } finally {
        await client.close();
    }
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
