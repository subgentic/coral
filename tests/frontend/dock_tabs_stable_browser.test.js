// #21684: the agent panel's tabs stay put. The Operator: "our sidebar items are jumping in and out of More", then "if it's too many, just remove the text and numbers and show all the icons instead of using More".
// There is no More: every tab is in the row in one fixed order; wide = words, narrower = icons alone (no word, no count); too narrow even for icons = the row scrolls sideways with every tab reachable.
// Selecting a tab or a count appearing never moves or hides a tab. Resizes across the widths and picks every tab.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ tabLayout: '{"agent":{"order":[],"hidden":["board","saved"]}}' });
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const ROW = '#agentic-block-top .agentic-state-tabs';
    const state = () => ev(`(() => { const r = document.querySelector('${ROW}'); const all = [...r.querySelectorAll('.agentic-tab[data-tab]')].filter(b => getComputedStyle(b).display !== 'none');
        const word = b => { const w = b.querySelector('.agentic-tab-word'); return w && getComputedStyle(w).display !== 'none'; };
        const count = b => { const c = b.querySelector('.agentic-tab-count'); return c && c.textContent && getComputedStyle(c).display !== 'none'; };
        const rb = r.getBoundingClientRect();
        return { width: r.clientWidth, scroll: r.scrollWidth - r.clientWidth, order: all.map(b => b.dataset.tab), words: r.hasAttribute('data-words'), open: (r.querySelector('.agentic-tab.active') || {}).dataset?.tab || '',
            wrapped: new Set(all.map(b => b.offsetTop)).size > 1, named: all.every(b => b.title && b.getAttribute('aria-label')), anyWord: all.some(word), anyCount: all.some(count), noMore: !document.getElementById('agentic-tab-more') && !document.getElementById('agentic-more-menu'),
            reachable: all.every(b => { b.scrollIntoView({ inline: 'nearest' }); const x = b.getBoundingClientRect(); return x.width > 0 && x.left >= rb.left - 1 && x.right <= rb.right + 1; }) }; })()`);
    const load = async (w, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__m.add('dock-bot', 'A', 3, { sleeping: false }); true`);
        await settle(ev, 600); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('dock-bot', 'claude', 'dock-bot-id', 'local'); true`);
        await ev(`(() => { const p = document.getElementById('agentic-state'); if (p.classList.contains('collapsed') || document.getElementById('agentic-tab-files').getBoundingClientRect().width === 0) window.toggleAgenticPanel(true); return true; })()`);
        await waitFor(`document.getElementById('agentic-tab-files').getBoundingClientRect().width > 0`, 'the panel', 8000);
        await settle(ev, 300); // sleep-ok: the row is measured after the words settle
    };
    // the row's own width, set directly, so one page is looked at at every width
    const setRow = async px => { await ev(`(() => { const s = document.getElementById('agentic-state'); s.style.setProperty('width', '${px}px', 'important'); s.style.setProperty('max-width', '${px}px', 'important'); s.style.setProperty('min-width', '0', 'important'); return true; })()`); await settle(ev, 400); }; // sleep-ok: the row is measured over a few frames
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load(1280, false);
        const ORDER = (await state()).order;
        assert.ok(ORDER.length >= 6, 'the page has its tabs: ' + ORDER);
        let sawWords = false, sawIcons = false, sawScroll = false;
        for (const px of [700, 560, 480, 420, 380, 340, 300, 280]) {
            await setRow(px);
            await ev(`document.getElementById('agentic-tab-files').click(); true`); await settle(ev, 200); // sleep-ok: the switch redraws the strip
            const base = await state();
            const check = (ok, msg) => { if (!ok) problems.push(`${px} (row ${base.width}): ${msg}`); };
            check(JSON.stringify(base.order) === JSON.stringify(ORDER), `the tabs keep one order: ${base.order} vs ${ORDER}`);
            check(base.noMore, 'there is no More button or menu');
            check(!base.wrapped, 'the row does not wrap');
            check(base.named, 'every tab has its title and aria-label');
            check(base.reachable, 'every tab can be scrolled into the row');
            check(base.words || (!base.anyWord && !base.anyCount), 'icons alone: no word, no count');
            sawWords = sawWords || base.words; sawIcons = sawIcons || !base.words; sawScroll = sawScroll || base.scroll > 0;
            // pick every tab in turn: nothing moves, nothing is hidden
            for (const t of ORDER) {
                await ev(`(() => { const b = document.querySelector('${ROW} .agentic-tab[data-tab="${t}"]'); b.scrollIntoView({ inline: 'nearest' }); b.click(); return true; })()`);
                await waitFor(`document.getElementById('agentic-panel-${t}') && document.getElementById('agentic-panel-${t}').classList.contains('active')`, `${px}: ${t} opens`, 5000);
                await settle(ev, 150); // sleep-ok: the switch redraws the strip
                const now = await state();
                check(JSON.stringify(now.order) === JSON.stringify(ORDER), `picking ${t} moved tabs: ${now.order}`);
                check(now.open === t, `${t} is the selected tab: ${now.open}`);
                check(now.noMore && !now.wrapped && (now.words || (!now.anyWord && !now.anyCount)), `picking ${t}: no More, one line, icons alone when the words are off: ${JSON.stringify(now)}`);
            }
            // a count appearing or growing never moves a tab either
            await ev(`document.getElementById('agentic-tab-files').click(); document.getElementById('files-bar-count').textContent = '88888'; true`); await settle(ev, 400); // sleep-ok: the row is measured
            const counted = await state();
            check(JSON.stringify(counted.order) === JSON.stringify(ORDER), `a count moved tabs: ${counted.order}`);
            check(!counted.wrapped && counted.noMore && counted.reachable, 'a count does not wrap the row or hide a tab');
            await ev(`document.getElementById('files-bar-count').textContent = ''; true`);
            if (px === 560 || px === 340) await shot(`dock-tabs-after-${px}`);
        }
        assert.ok(sawWords && sawIcons && sawScroll, `words when they fit, icons below that, and a sideways scroll at the narrowest: ${[sawWords, sawIcons, sawScroll]}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the agent panel tabs:\n  ' + problems.join('\n  '));
    console.log('PASS the tabs keep their order and place, with no More: words, then icons, then a sideways scroll');
})().catch(e => { console.error(e); process.exit(1); });
