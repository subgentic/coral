// The mailbox's view list (view_list.js, #7785): at a desktop's width a column of views with a count each, one of them current (aria-current, a bar and weight), a view not built yet disabled and saying "soon"
// in words, a tag's colour dot; below the phone width the same views are ONE tab strip of 44 px text tabs (#11236, #11239 slice A; the select stays in the DOM, hidden). Picking calls back once; a disabled view never; an update keeps the keyboard on its item; a dot that is not a hex
// colour draws nothing.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const SECTIONS = `[{ title: 'Views', items: [{ key: 'all', label: 'All chats', count: 183, alert: true }, { key: 'groups', label: 'Board history', count: 0, alert: true }, { key: 'active', label: 'Active now', soon: true }] },
    { title: 'Tags', items: [{ key: 'tag:1', label: 'release', count: 14, dot: '#be185d' }, { key: 'tag:2', label: 'bad', count: 1, dot: 'url(javascript:1)' }] }]`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    let failed = 0;
    const check = (label, fn) => Promise.resolve().then(fn).then(() => console.log(`   ok   ${label}`), e => { failed++; console.log(`   FAIL ${label}: ${e.message}`); });
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`import((window.__coralStatic || '/static/') + 'view_list.js').then(m => { window.__vl = m; window.__picked = []; const host = document.createElement('div'); host.id = 'vl-host'; host.style.cssText = 'position:fixed;inset:0 auto 0 0;width:' + (innerWidth < 768 ? '100%' : '260px') + ';z-index:99999;background:var(--bg-primary)'; document.body.append(host);
                window.__root = m.build({ id: 'test', label: 'Chat views', sections: ${SECTIONS}, current: 'all', onPick: k => window.__picked.push(k) }); host.append(window.__root); return true; })`);
            const probe = () => ev(`(() => { const r = window.__root, vis = e => !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
                const nav = r.querySelector('.view-list-nav'), sel = r.querySelector('.view-list-select'), items = [...r.querySelectorAll('.view-list-item')];
                return { nav: vis(nav), sel: vis(sel), selH: Math.round(sel.getBoundingClientRect().height), current: items.filter(b => b.getAttribute('aria-current') === 'true').map(b => b.dataset.key),
                    soon: items.filter(b => b.disabled).map(b => b.dataset.key + ':' + b.textContent.trim()), titles: [...r.querySelectorAll('.view-list-title')].map(e => e.textContent), minH: Math.min(...items.map(b => Math.round(b.getBoundingClientRect().height))),
                    dots: [...r.querySelectorAll('.view-list-dot')].map(d => d.style.getPropertyValue('--view-list-dot')), options: [...sel.querySelectorAll('option')].map(o => o.textContent + (o.selected ? '*' : '')),
                    alerts: [...r.querySelectorAll('.view-list-alert')].map(e => e.textContent), groups: [...sel.querySelectorAll('optgroup')].map(g => g.label), counts: items.map(b => b.querySelector('.view-list-count') ? b.querySelector('.view-list-count').textContent : ''), side: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
            await check(`${label}: ${mobile ? 'one tab strip, no select' : 'the column, no select'}`, async () => {
                const p = await probe();
                assert.equal(p.nav, true, JSON.stringify(p)); assert.equal(p.sel, false, JSON.stringify(p));
                if (mobile) assert.ok(p.minH >= 44, `a tab is 44 px: ${p.minH}`); else assert.ok(p.minH >= 32, `an item is at least 32 px: ${p.minH}`);
                if (mobile) assert.equal(await ev(`getComputedStyle(window.__root.querySelector('.view-list-nav')).flexDirection`), 'row', 'the strip is a row of tabs');
                assert.equal(p.side, 0, 'nothing scrolls sideways');
            });
            if (!mobile) await check(`${label}: the select's border is the controls' border colour (3:1 on the page, WCAG 1.4.11), as every other select's (#7946)`, async () => {
                const c = await ev(`(() => { const probe = document.createElement('i'); probe.style.borderTop = '1px solid var(--control-border)'; document.body.append(probe); const want = getComputedStyle(probe).borderTopColor; probe.remove(); return [getComputedStyle(window.__root.querySelector('.view-list-select')).borderTopColor, want]; })()`);
                assert.equal(c[0], c[1], JSON.stringify(c));
            });
            await check(`${label}: the current view, the counts, "soon" in words, the sections and the colour dot`, async () => {
                const p = await probe();
                assert.deepEqual(p.current, ['all'], JSON.stringify(p));
                assert.deepEqual(p.soon, ['active:Active nowsoon'], JSON.stringify(p));
                assert.deepEqual(p.titles, ['Views', 'Tags']); // the strip has no section titles to draw: they stay in the DOM and are hidden
                assert.deepEqual(p.counts, ['183', '0', 'soon', '14', '1'], JSON.stringify(p));
                assert.deepEqual(p.alerts, ['183'], 'only a count above 0 that asks for it is the red pill: ' + JSON.stringify(p));
                assert.deepEqual(p.groups, ['Views', 'Tags'], 'the sections are the select\'s groups: ' + JSON.stringify(p));
                assert.deepEqual(p.dots, ['#be185d'], 'a colour that is not a hex draws no dot: ' + JSON.stringify(p));
                assert.deepEqual(p.options, ['All chats (183)*', 'Board history (0)', 'release (14)', 'bad (1)'], 'the select holds the views that can be picked: ' + JSON.stringify(p));
            });
            await check(`${label}: picking calls back once, a disabled view never, and an update moves the current view and keeps the keyboard`, async () => {
                await ev(`(() => { const b = k => window.__root.querySelector('.view-list-item[data-key="' + k + '"]'); b('active').click(); b('groups').click(); return true; })()`);
                assert.deepEqual(await ev(`window.__picked`), ['groups']);
                await ev(`(() => { const b = window.__root.querySelector('.view-list-item[data-key="tag:1"]'); if (!${mobile}) b.focus(); window.__vl.update(window.__root, { sections: [{ title: 'Views', items: [{ key: 'all', label: 'All chats', count: 184 }, { key: 'groups', label: 'Board history', count: 12 }] }, { title: 'Tags', items: [{ key: 'tag:1', label: 'release', count: 14, dot: '#be185d' }] }], current: 'groups' }); return true; })()`);
                const after = await ev(`({ current: [...window.__root.querySelectorAll('[aria-current="true"]')].map(b => b.dataset.key), focus: document.activeElement.dataset ? document.activeElement.dataset.key || '' : '', n: window.__root.querySelectorAll('.view-list-item').length })`);
                assert.deepEqual(after.current, ['groups']); assert.equal(after.n, 3);
                if (!mobile) assert.equal(after.focus, 'tag:1', 'the keyboard stays on the item it was on');
            });
        }
    } catch (e) { failed++; console.log('   FAIL the test ran: ' + (e.stack || e)); }
    await client.close();
    console.log(failed ? `FAIL: ${failed}` : 'PASS view list');
    process.exit(failed ? 1 : 0);
})();
