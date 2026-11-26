// #21684: the agent panel's tabs stay put. The Operator: "our sidebar items are jumping in and out of More". The tabs keep one order, and More is the LAST thing of the row. At a narrow panel the words go to
// icons first so every tab stays visible; only when icons do not fit do the LAST tabs go under More, and which ones depends on the row's width alone: not on the selected tab, not on a count. Selecting a tab never
// reorders the strip. Resizes across the widths and picks every tab, from the row and from More.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ tabLayout: '{"agent":{"order":[],"hidden":["board","saved"]}}' });
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const ROW = '#agentic-block-top .agentic-state-tabs';
    const state = () => ev(`(() => { const r = document.querySelector('${ROW}'); const all = [...r.querySelectorAll('.agentic-tab[data-tab]')].filter(b => getComputedStyle(b).display !== 'none');
        const id = b => b.dataset.tab; const more = document.getElementById('agentic-more'); const kids = [...r.children].filter(c => getComputedStyle(c).display !== 'none' && !c.classList.contains('tab-more'));
        const word = b => { const w = b.querySelector('.agentic-tab-word'); return w && getComputedStyle(w).display !== 'none'; };
        return { width: r.clientWidth, row: all.filter(b => !b.classList.contains('tab-more')).map(id), behind: all.filter(b => b.classList.contains('tab-more')).map(id), order: all.map(id),
            moreLast: !more.hidden && getComputedStyle(more).display !== 'none' ? (more.compareDocumentPosition(document.getElementById('agentic-tab-customize')) & Node.DOCUMENT_POSITION_FOLLOWING) && !all.some(b => b.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_PRECEDING) : true, moreShown: !document.getElementById('agentic-tab-more').hidden, moreActive: document.getElementById('agentic-tab-more').classList.contains('active'),
            menu: [...document.querySelectorAll('#agentic-more-menu [data-tab]')].map(id), open: (r.querySelector('.agentic-tab.active') || {}).dataset?.tab || '', words: r.hasAttribute('data-words'), wrapped: new Set(all.filter(b => !b.classList.contains('tab-more')).map(b => b.offsetTop)).size > 1, named: all.every(b => b.title && b.getAttribute('aria-label')), anyWord: all.some(word) }; })()`);
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
    const setRow = async px => { await ev(`(() => { const s = document.getElementById('agentic-state'); s.style.setProperty('width', '${px}px', 'important'); s.style.setProperty('max-width', '${px}px', 'important'); s.style.setProperty('min-width', '0', 'important'); return true; })()`); await settle(ev, 400); }; // sleep-ok: the observers redraw the row over frames
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load(1280, false);
        let s0 = await state();
        const ORDER = s0.order;
        assert.ok(ORDER.length >= 6, 'the page has its tabs: ' + JSON.stringify(s0));
        const seenBehind = new Map(); // row width -> tabs behind More with nothing open but Files
        for (const px of [700, 560, 480, 420, 380, 340, 300, 280]) {
            await setRow(px);
            await ev(`document.getElementById('agentic-tab-files').click(); true`); await settle(ev, 200); // sleep-ok: the switch redraws the strip
            const base = await state();
            const check = (ok, msg) => { if (!ok) problems.push(`${px} (row ${base.width}): ${msg}`); };
            check(JSON.stringify(base.order) === JSON.stringify(ORDER), `the tabs keep one order: ${base.order} vs ${ORDER}`);
            check(JSON.stringify([...base.row, ...base.behind]) === JSON.stringify(ORDER), `the row then More hold the tabs in order: ${base.row} | ${base.behind}`);
            check(base.moreShown === (base.behind.length > 0), 'More is there exactly when a tab is behind it');
            check(base.moreLast, 'More is the last of the row, before Customize');
            check(!base.wrapped, 'the row does not wrap');
            check(base.named, 'every tab has its title and aria-label');
            seenBehind.set(px, base.behind.join());
            // pick every tab in turn, from the row or from More: nothing moves
            for (const t of ORDER) {
                if (base.behind.includes(t)) {
                    await ev(`document.getElementById('agentic-tab-more').click(); true`);
                    await waitFor(`!document.getElementById('agentic-more-menu').hidden`, `${px}: the More menu opens`, 4000);
                    await ev(`document.querySelector('#agentic-more-menu [data-tab="${t}"]').click(); true`);
                } else await ev(`document.querySelector('${ROW} .agentic-tab[data-tab="${t}"]').click(); true`);
                await waitFor(`document.getElementById('agentic-panel-${t}') && document.getElementById('agentic-panel-${t}').classList.contains('active')`, `${px}: ${t} opens`, 5000);
                await settle(ev, 150); // sleep-ok: the switch redraws the strip
                const now = await state();
                check(JSON.stringify(now.row) === JSON.stringify(base.row) && JSON.stringify(now.behind) === JSON.stringify(base.behind), `picking ${t} moved tabs: row ${base.row} -> ${now.row}, behind ${base.behind} -> ${now.behind}`);
                check(now.open === t || base.behind.includes(t), `${t} is the selected tab: ${now.open}`);
                if (base.behind.includes(t)) check(now.moreActive && now.menu.includes(t), `${t} is open behind More: More is lit and the menu still holds it`);
                else check(!now.moreActive, `${t} is in the row: More is not lit`);
            }
            // a count appearing or growing never moves a tab either
            await ev(`document.getElementById('agentic-tab-files').click(); document.getElementById('files-bar-count').textContent = '88888'; true`); await settle(ev, 400); // sleep-ok: the row is measured
            const counted = await state();
            check(JSON.stringify(counted.row) === JSON.stringify(base.row) && JSON.stringify(counted.behind) === JSON.stringify(base.behind), `a count moved tabs: ${base.row}|${base.behind} -> ${counted.row}|${counted.behind}`);
            check(!counted.wrapped, 'a count does not wrap the row');
            await ev(`document.getElementById('files-bar-count').textContent = ''; true`);
            if (px === 560 || px === 340) await shot(`dock-tabs-after-${px}`);
        }
        // narrower never brings a tab back, wider never sends one: the tabs behind More are always the LAST ones, and the set grows as the row narrows
        let prev = [];
        for (const px of [700, 560, 480, 420, 380, 340, 300, 280]) {
            const cur = seenBehind.get(px).split(',').filter(Boolean);
            assert.ok(cur.length >= prev.length && prev.every((t, i) => cur[cur.length - prev.length + i] === t) && cur.every((t, i) => ORDER[ORDER.length - cur.length + i] === t), `More holds the LAST tabs, and narrowing only adds the ones before them: ${prev} -> ${cur} at ${px}`);
            prev = cur;
        }
        // icons come first: at a width where the words do not fit but the icons do, no tab is behind More
        assert.ok([...seenBehind.values()].some(v => v === ''), 'at some width every tab stays visible as an icon: ' + JSON.stringify([...seenBehind]));
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the agent panel tabs:\n  ' + problems.join('\n  '));
    console.log('PASS the tabs keep their order and place; only the last ones go under More, by width alone');
})().catch(e => { console.error(e); process.exit(1); });
