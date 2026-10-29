// Docs, an accessibility look (task 7751, UI/UX's #7734 follow-up): on a phone the way back is on the topic title's line (and over it at 200% text, where the title would not have 10 rem beside it), and it is
// still one button after the page redraws the topic; every topic is one h1 and then headings that never skip a level; a code block that scrolls sideways is a labelled, focusable region (a keyboard reaches what overflows)
// and one that fits is not a tab stop; no topic scrolls the page sideways at 390 px or at 200% text. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server and the real docs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`window.switchNavTab('docs'); true`); await waitFor(`document.querySelectorAll('#docs-nav-list [data-doc]').length >= 5`, 'the topics', 15000);
        return ev(`[...document.querySelectorAll('#docs-nav-list [data-doc]')].map(e => e.dataset.doc)`);
    };
    const select = async n => { await ev(`window.selectDoc(${JSON.stringify(n)}); true`); await waitFor(`!!document.querySelector('#docs-content h1')`, `the topic ${n}`, 8000); await settle(300); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const names = await open(390, 844, true);
        await S.run('390 px: the way back is on the topic title\'s line, still one button after the page redraws the topic, and a code block that scrolls is a focusable region', async () => {
            await select(names[0]);
            const geo = () => ev(`(() => { const b = document.getElementById('docs-phone-back'), t = document.querySelector('#docs-content h1'), r = b.getBoundingClientRect(), q = t.getBoundingClientRect(); return { n: document.querySelectorAll('#docs-phone-back').length, inContent: !!b.closest('#docs-content'), shown: b.getClientRects().length > 0, beside: q.top < r.bottom - 1 && q.left >= r.right - 2, over: r.bottom <= q.top + 1 }; })()`);
            const g1 = await geo(); assert.deepEqual([g1.n, g1.inContent, g1.shown, g1.beside], [1, true, true, true], 'beside the title: ' + JSON.stringify(g1)); await shot('docs-390');
            await select(names[1]); const g2 = await geo(); assert.deepEqual([g2.n, g2.inContent, g2.shown, g2.beside], [1, true, true, true], 'after another topic: ' + JSON.stringify(g2));
            await select('troubleshooting');
            const code = await ev(`[...document.querySelectorAll('#docs-content pre')].map(p => ({ scrolls: p.scrollWidth > p.clientWidth + 1, tab: p.tabIndex, role: p.getAttribute('role'), label: p.getAttribute('aria-label') }))`);
            assert.ok(code.some(c => c.scrolls), 'a code block of Troubleshooting scrolls at 390 px: ' + JSON.stringify(code));
            for (const c of code) assert.deepEqual(c.scrolls ? [c.tab, c.role, c.label] : [c.tab, c.role], c.scrolls ? [0, 'region', 'Code, scrolls sideways'] : [-1, null], JSON.stringify(c));
        });
        await S.run('390 px at 200% text: the way back is over the title when it would not have 10 rem beside it, and no topic scrolls the page sideways', async () => {
            await ev(`document.documentElement.style.fontSize = '32px'; true`); await select(names[0]); await settle(400);
            const g = await ev(`(() => { const b = document.getElementById('docs-phone-back').getBoundingClientRect(), t = document.querySelector('#docs-content h1').getBoundingClientRect(); return { over: b.bottom <= t.top + 1, titleWidth: Math.round(t.width) }; })()`); await shot('docs-390-200');
            assert.ok(g.over && g.titleWidth > 200, 'over the title, which has the width of the screen: ' + JSON.stringify(g));
            const wide = [];
            for (const n of names) { await select(n); if (await ev(`document.documentElement.scrollWidth > innerWidth + 1`)) wide.push(n); }
            await ev(`document.documentElement.style.fontSize = ''; true`);
            assert.deepEqual(wide, [], 'topics that scroll the page sideways at 200% text');
        });
        await S.run('every topic is one h1 and then headings that never skip a level', async () => {
            const bad = [];
            for (const n of names) {
                await select(n);
                const r = await ev(`(() => { const hs = [...document.querySelectorAll('#docs-content h1, #docs-content h2, #docs-content h3, #docs-content h4, #docs-content h5, #docs-content h6')].map(e => +e.tagName[1]); const skips = hs.map((l, i) => (i === 0 ? l !== 1 : l > hs[i - 1] + 1) ? [i, l] : null).filter(Boolean); return { h1: hs.filter(l => l === 1).length, skips }; })()`);
                if (r.h1 !== 1 || r.skips.length) bad.push(`${n}: ${JSON.stringify(r)}`);
            }
            assert.deepEqual(bad, [], 'topics with a heading level skipped');
        });
        await S.run('390 px: a topic opened by a tap leaves its title with no focus ring (the heading takes the focus, :focus-visible does not match), and one opened from the keyboard keeps it', async () => {
            await open(390, 844, true);
            const tap = async sel => { const pt = await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.getClientRects().length); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [pt] }); await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); };
            const state = () => ev(`(() => { const h = document.querySelector('#docs-content h1'), a = document.activeElement; return { onTitle: a === h, focusVisible: !!a && a.matches(':focus-visible'), outline: h ? getComputedStyle(h).outlineStyle : null }; })()`);
            await tap('#mobile-docs-list [data-doc], #mobile-docs-list .group-table-link, #mobile-docs-list .row-btn'); await waitFor(`!!document.querySelector('#docs-content h1') && document.activeElement === document.querySelector('#docs-content h1')`, 'the title to have the focus after the tap', 8000);
            const tapped = await state(); assert.deepEqual(tapped, { onTitle: true, focusVisible: false, outline: 'none' }, 'after a tap: ' + JSON.stringify(tapped));
            await ev(`document.activeElement.blur(); true`);
            await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
            await ev(`window.selectDoc(${JSON.stringify(names[2])}); true`); await waitFor(`document.activeElement === document.querySelector('#docs-content h1')`, 'the title to have the focus after the keyboard', 8000);
            const keyed = await state(); assert.deepEqual([keyed.onTitle, keyed.focusVisible, keyed.outline !== 'none'], [true, true, true], 'after the keyboard: ' + JSON.stringify(keyed));
        });
        const wideNames = await open(1280, 800, false);
        await S.run('1280 px: the way back is the toolbar\'s, hidden, and the topic title is alone in its row', async () => {
            await select(wideNames[0]);
            const g = await ev(`(() => { const b = document.getElementById('docs-phone-back'); return { inToolbar: !!b.closest('.docs-toolbar'), shown: b.getClientRects().length > 0, row: !!document.querySelector('#docs-content .phone-title-row') }; })()`);
            assert.deepEqual(g, { inToolbar: true, shown: false, row: false }, JSON.stringify(g));
        });
    } finally { await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
