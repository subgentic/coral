// Artifact comments at the cap (#5255): 500 comments on a 1 MB Markdown file and on a 5,000-line code file open, answer a click on a card and take a posted comment without a long freeze. Before the
// fix every one of those indexed the whole document's text a character at a time (6 s on the Markdown file, 0.6 s on the code, on the main thread, for each click and each post); now the index is
// made once and kept while the text nodes stay. The budgets are about ten times what is measured (comments_scale_probe_browser measures, opt-in), so a slow machine does not fail them and the old
// cost, thirty times over them, does. The highlights and the cards still agree: 400 threads, 320 open, the clicked one current in both.
const { connect } = require('./agent_view_harness');
const { fixture, STUB } = require('./helpers/comments_scale');
const { framesJs, coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

// The budgets are CPU time, not wall-clock time (#18137): a loaded runner stretches wall-clock without the viewer being slower (a posted comment took 10 s in a full CDP set and 84 to 150 ms alone;
// the open took 2788 ms against 2500 with other processes busy). The renderer's CPU time, read from the browser (SystemInfo.getProcessInfo) before and after each action, is what the viewer
// spent, whoever else wants the machine. It is a little more than the main thread's own time (the compositor and raster threads count), so the budgets stay at the ten times of what is measured
// that they were; a slowed CPU (--stress's CDP_CPU_THROTTLE) slows the work and so its CPU time too, hence SCALE (#352). The old cost, thirty times over, still fails.
const SCALE = Math.min(8, Math.max(1, Number(process.env.CDP_CPU_THROTTLE) || 1)); // missing, empty or not a number: 1; at most 8
const OPEN_MS = 2500 * SCALE, CLICK_MS = 1000 * SCALE, POST_MS = 1500 * SCALE, SELECT_MS = 1500 * SCALE;
const CDP = require('chrome-remote-interface');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const browser = await CDP({ target: (await CDP.Version({ port: Number(process.env.CDP_PORT || 9222) })).webSocketDebuggerUrl });
    const cpu = async () => (await browser.SystemInfo.getProcessInfo()).processInfo.filter(p => p.type === 'renderer').reduce((n, p) => n + p.cpuTime, 0) * 1000; // ms of CPU, every renderer
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        for (const kind of ['markdown', 'code']) {
            const fx = fixture(kind);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(STUB(fx));
            const t0 = Date.now(), c0 = await cpu();
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer(window.__HEX, { filename: ${JSON.stringify(fx.filename)} })); true`);
            await waitFor(`document.querySelectorAll('.ac-card').length > 0 && !!(CSS.highlights.get('ac-comment') && CSS.highlights.get('ac-comment').size)`, 'the cards and the highlights', 30000);
            const openMs = Math.round(await cpu() - c0), openWall = Date.now() - t0;
            const s = await ev(`({ cards: document.querySelectorAll('.ac-card, .ac-draft-card').length, highlights: CSS.highlights.get('ac-comment').size, orphans: document.querySelectorAll('.ac-orphan').length })`);
            check(`${kind}: ${fx.comments.length} comments open with a card and a highlight for each open thread (320 of 400), none orphaned`, s.cards === 320 && s.highlights === 320 && s.orphans === 0, JSON.stringify(s));
            check(`${kind}: the viewer opens with its comments in ${OPEN_MS} ms`, openMs <= OPEN_MS, openMs + ' ms of CPU (' + openWall + ' ms on the clock)');
            // a click on a card: the card is current, so is its highlight, and it took no long freeze
            const cc0 = await cpu();
            const c = await ev(`(async () => {
                const cs = [...document.querySelectorAll('.ac-card')]; const worst = []; let last = null;
                for (const i of [3, 150, 300]) { const card = cs[i]; const t = performance.now(); card.click(); await ${framesJs(2, 10000)}; worst.push(Math.round(performance.now() - t)); last = card.dataset.id; }
                const now = document.querySelector('.ac-card.ac-active');
                return { ms: Math.max(...worst), activeId: now && now.dataset.id, want: last, activeHl: CSS.highlights.get('ac-active') ? CSS.highlights.get('ac-active').size : 0, openHl: CSS.highlights.get('ac-comment').size };
            })()`);
            const clickCpu = Math.round((await cpu() - cc0) / 3); // three clicks: the CPU of one
            check(`${kind}: a click on a card makes it and its highlight current, in ${CLICK_MS} ms of CPU (one of three)`, clickCpu <= CLICK_MS && c.activeId === c.want && c.activeHl === 1 && c.openHl === 320, JSON.stringify({ ...c, clickCpu }));
            // a selection in the middle of the document: the Comment button is there, with the quote it will anchor (building the anchor squashed the whole source on every change, 6 s on the Markdown file)
            const cs0 = await cpu();
            const sel = await ev(`(async () => {
                const body = document.querySelector('#artifact-viewer .artifact-viewer-body'); const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const ns = []; for (let n = w.nextNode(); n; n = w.nextNode()) ns.push(n);
                const n = ns.slice(Math.floor(ns.length * 0.7)).find(x => x.nodeValue.trim().length >= 30); const range = document.createRange(); range.setStart(n, 0); range.setEnd(n, 30);
                const t = performance.now(); const s = getSelection(); s.removeAllRanges(); s.addRange(range);
                await new Promise((res, rej) => { const end = t + 20000; const tick = () => { const b = document.querySelector('.ac-selbtn'); if (b && !b.hidden) return res(); if (performance.now() > end) return rej(new Error('no Comment button')); setTimeout(tick, 5); }; tick(); });
                const ms = Math.round(performance.now() - t); s.removeAllRanges(); return { ms };
            })()`);
            const selCpu = Math.round(await cpu() - cs0);
            check(`${kind}: a selection shows the Comment button in ${SELECT_MS} ms of CPU`, selCpu <= SELECT_MS, JSON.stringify({ ...sel, selCpu }));
            // a posted comment: it is in the list, the document is not indexed again for it, and it took no long freeze
            const cp0 = await cpu();
            const p = await ev(`(async () => {
                document.querySelector('.ac-whole')?.click(); const ta = document.querySelector('.ac-input'); ta.value = 'A comment on the whole document.'; ta.dispatchEvent(new Event('input'));
                const t = performance.now(); document.querySelector('.ac-composer').requestSubmit();
                await new Promise((res, rej) => { const end = t + 20000; const tick = () => { if ([...document.querySelectorAll('.ac-draft-card p')].some(e => e.textContent === 'A comment on the whole document.')) return res(); if (performance.now() > end) return rej(new Error('the post did not show')); setTimeout(tick, 5); }; tick(); });
                await ${framesJs(2, 10000)};
                return { ms: Math.round(performance.now() - t), cards: document.querySelectorAll('.ac-card, .ac-draft-card').length, openHl: CSS.highlights.get('ac-comment').size };
            })()`);
            const postCpu = Math.round(await cpu() - cp0);
            check(`${kind}: a posted comment shows in ${POST_MS} ms of CPU, the other highlights stay`, postCpu <= POST_MS && p.cards === 321 && p.openHl === 320 && (await ev(`window.__drafts.length === 1 && window.__cs.length === 500`)), JSON.stringify({ ...p, postCpu }));
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        }
    } finally { await browser.close().catch(() => {}); /* the harness closes Chrome */ }
    const failed = results.filter(r => !r).length;
    console.log(`comments_scale: ${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
