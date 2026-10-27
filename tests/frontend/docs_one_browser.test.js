// Docs on the shared sidebar (#7470, part 2 of one sidebar, UI/UX's audit c2596330): the Docs pane has the header's parts in the same pixels as the other tabs (search named "Search docs", no Display options,
// Expand or collapse all, Hide), two groups (Getting started, API) whose name opens a one-column table of topics at 20/700 with its count and whose chevron only folds; a topic opens as a page with its own
// "← group" link, the document at its reading scale (headings 20/700 and 17/700, table headers 12/500, bold labels 14/600, body 14/400) and "Copy docs line for agents" as a normal button in the page header;
// the search narrows the topics; one empty line; both themes and 200% text; on a phone the list is the page and a topic is the screen after it, with a way back to the list. The real docs of the isolated
// dev server are read, so the grouping is checked on the real topics. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const pane = tab => `.sidebar-pane[data-pane="${tab}"]`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`);
    const ON_SCALE = `(root, sizes, skip) => { const want = getComputedStyle(document.body).fontFamily, out = [];
        for (const e of root.querySelectorAll('*')) { if (!e.getClientRects().length || e.matches('.material-icons, .sr-only, pre, code, svg, svg *') || e.closest('pre, code')) continue;
            if (skip && e.closest(skip)) continue;
            if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
            const c = getComputedStyle(e), px = parseFloat(c.fontSize); const label = e.tagName + '.' + e.className + ' "' + e.textContent.trim().slice(0, 24) + '" ' + c.fontSize + '/' + c.fontWeight;
            if (c.fontFamily !== want) out.push('family ' + label); else if (!sizes.includes(px)) out.push('size ' + label); else if (!['400', '500', '600', '700'].includes(c.fontWeight)) out.push('weight ' + label); }
        return out; }`;
    const SCALE = '[11, 12, 13, 14, 16, 20]'; // the type scale (Goal #84): 17 is retired, 16 is --fs-xl
    const openTab = async tab => {
        await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`);
        await waitFor(`!document.querySelector('${pane(tab)}').hidden`, `the ${tab} pane`, 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [1024, 768, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

            await openTab('docs');
            await waitFor(`document.querySelectorAll('${pane('docs')} .sgroup-header').length === 2 && document.querySelectorAll('${pane('docs')} li .row-btn').length > 10`, at + 'the groups and the topics', 15000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane('docs')} .sgroup-header .group-name-text')].map(e => e.textContent)`), ['Getting started', 'API'], at + 'two groups');
            // the button is the row: the li around it has no padding and the button is 36 px high (44 on a phone), UI/UX's rule for every sidebar list (#7473)
            assert.deepEqual(await ev(`(() => { const b = document.querySelector('${pane('docs')} li:not(.session-group-header) > .row-btn'), li = b.parentElement, cs = getComputedStyle(li); return { pad: [cs.paddingTop, cs.paddingBottom], h: Math.round(b.getBoundingClientRect().height) >= ${mobile ? 44 : 36}, same: Math.abs(li.getBoundingClientRect().height - b.getBoundingClientRect().height) <= 1 }; })()`), { pad: ['0px', '0px'], h: true, same: true }, at + 'a row is its button, no padding on the li, at least ${mobile ? 44 : 36} px high');

            const counts = await ev(`[...document.querySelectorAll('${pane('docs')} .sgroup-header .session-group-count')].map(e => Number(e.textContent))`);
            assert.equal(counts[0] + counts[1], await ev(`document.querySelectorAll('${pane('docs')} li .row-btn').length`), at + 'the counts are the topics');
            assert.ok(counts[0] >= 1 && counts[1] >= 1, at + 'both groups have topics: ' + counts);
            assert.equal(await ev(`document.querySelector('${pane('docs')} .sidebar-search-input').getAttribute('aria-label')`), 'Search docs', at + 'the search is named for the tab');
            assert.equal(await ev(`!!document.querySelector('${pane('docs')} [data-display-button]')`), false, at + 'Docs has no Display options, so no button for them');
            assert.equal(await ev(`document.getElementById('docs-topics-btn')`), null, at + 'the Topics sheet button is gone: the list is the sidebar (or the phone page)');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');

            if (mobile) {
                // the phone's list IS the page; a topic is the screen after it, with the way back to the list
                assert.equal(await ev(`!!document.querySelector('#mobile-docs-list ${pane('docs')}')`), true, at + 'the Docs pane is in the phone page');
                assert.equal(await ev(`[...document.querySelectorAll('#mobile-docs-list .sidebar-hide-btn')].some(b => b.getClientRects().length > 0)`), false, at + 'no Hide on a phone');
                assert.equal(await ev(`document.getElementById('docs-page').getClientRects().length`), 0, at + 'the document is not shown until a topic is chosen');
                await shot(`docs-one-list-${w}`);
                await ev(`document.querySelector('${pane('docs')} li .row-btn').click(); true`);
                await waitFor(`document.getElementById('docs-page').getClientRects().length > 0 && !!document.querySelector('#docs-content h1')`, at + 'the topic as a screen', 10000);
                assert.equal(await ev(`document.getElementById('mobile-docs-list').getClientRects().length`), 0, at + 'and the list is not under it');
                assert.equal(await ev(`document.getElementById('docs-phone-back').textContent.trim()`), '\u2190 Docs', at + 'with the way back');
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, at + 'no sideways scroll on a topic');
                await shot(`docs-one-topic-${w}`);
                await ev(`document.getElementById('docs-phone-back').click(); true`);
                await waitFor(`document.getElementById('mobile-docs-list').getClientRects().length > 0 && document.getElementById('docs-page').getClientRects().length === 0`, at + 'back is the list', 4000);
                continue;
            }

            // the header's parts are in the same pixels as on the other tabs
            const parts = {};
            for (const tab of ['agents', 'docs']) {
                await openTab(tab);
                parts[tab] = { search: await rect(`${pane(tab)} .sidebar-search-input`), hide: await rect(`${pane(tab)} .sidebar-hide-btn`), header: await rect(`${pane(tab)} .sidebar-header`) };
            }
            assert.deepEqual(parts.docs.hide, parts.agents.hide, at + 'Hide is in the same place on Docs as on Agents');
            assert.deepEqual(parts.docs.search.slice(0, 2), parts.agents.search.slice(0, 2), at + 'the search starts in the same place');
            assert.equal(parts.docs.search[3], parts.agents.search[3], at + 'the search is as tall');
            await openTab('docs');
            assert.ok(await rect(`${pane('docs')} [data-group-toggle]`), at + 'Expand or collapse all is there');

            // the tab opens on its first group's table
            await waitFor(`!!document.querySelector('#group-table-view table.dt-table') && document.getElementById('group-table-view').checkVisibility()`, at + 'the first group as a table', 10000);
            assert.equal(await ev(`document.querySelector('#group-table-title').textContent`), 'Getting started', at + 'the first group is Getting started');
            // UI/UX's #7588 item 8: the group head is one fixed row (36 px, 44 on a phone) with a header button or without, so the title is where every other tab has it
            assert.equal(await ev(`(() => { const v = document.getElementById('group-table-view'), t = document.querySelector('#group-table-title').getBoundingClientRect(), h = document.querySelector('#group-table-view .group-table-head').getBoundingClientRect(); const m = innerWidth < 768 || matchMedia('(pointer: coarse)').matches ? 44 : 36;
                return Math.round(h.height) === m && Math.abs(t.top - (v.getBoundingClientRect().top + parseFloat(getComputedStyle(v).paddingTop) + (m - t.height) / 2)) < 1.5; })()`), true, at + 'the title row is one fixed height');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => [h.querySelector('.dt-sort > span').textContent, h.getAttribute('scope')])`), [['Topic', 'col']], at + 'a one-column table of topics');
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr').length`), counts[0], at + "one row per topic of the group");
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#group-table-title')), c = getComputedStyle(document.querySelector('#group-table-view .group-table-head .session-group-count')); return [t.fontSize, t.fontWeight, c.fontSize, c.fontWeight]; })()`), ['20px', '700', '11px', '600'], at + "the title is 20/700 and its count 11/600");
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the topics table is on the scale');
            assert.deepEqual(await ev(`(() => { const b = document.querySelector('#group-table-view .group-table-head .group-table-extra'); return b ? [b.textContent.trim(), b.classList.contains('btn')] : null; })()`), ['content_copy Copy docs line for agents', true], at + 'Copy docs line for agents is a normal button in the table\'s head too');
            const subtitles = await ev(`(() => { const xs = [...document.querySelectorAll('#group-table-view .dt-subtitle')]; return xs.map(e => ({text: e.textContent, size: getComputedStyle(e).fontSize, weight: getComputedStyle(e).fontWeight})); })()`);
            assert.ok(subtitles.length > 0, at + 'real API topics include summary subtitles');
            assert.ok(subtitles.every(s => s.text.trim() && !s.text.includes(String.fromCharCode(10)) && s.size === '12px' && s.weight === '400'), at + 'subtitles are one line at 12/400');
            await shot(`docs-one-table-${w}`);

            // a topic: the page, its way back, the document at its reading scale, and the copy button in the header
            await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
            await waitFor(`document.getElementById('docs-view').checkVisibility() && !!document.querySelector('#docs-content h1') && document.getElementById('docs-back').checkVisibility()`, at + 'the topic page', 10000);
            await waitFor(`document.activeElement === document.querySelector('#docs-content h1')`, at + 'opening a table topic focuses its heading', 4000);
            assert.equal(await ev(`document.getElementById('docs-back').textContent`), '← Getting started', at + 'back names the group');
            assert.deepEqual((await ev(`(() => { const s = sel => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return c.fontSize + '/' + c.fontWeight; }; return [s('#docs-content h1'), s('#docs-content h2'), s('#docs-content th'), s('#docs-content p strong, #docs-content li strong'), s('#docs-content p')]; })()`)).slice(0, 2), ['20px/700', '16px/600'], at + 'headings 20/700 and 16/600 (the type scale, Goal #84)');
            assert.equal(await ev(`(() => { const e = document.querySelector('#docs-content th'); if (!e) return '12px/500'; const c = getComputedStyle(e); return c.fontSize + '/' + c.fontWeight; })()`), '12px/500', at + 'a table header is 12/500');
            assert.equal(await ev(`(() => { const e = document.querySelector('#docs-content p strong, #docs-content li strong'); if (!e) return '14px/600'; const c = getComputedStyle(e); return c.fontSize + '/' + c.fontWeight; })()`), '14px/600', at + 'a bold label is 14/600');
            const copy = await ev(`(() => { const b = document.getElementById('docs-copy-agent-line'); const t = document.querySelector('.docs-toolbar'); const r = b.getBoundingClientRect(); return { inToolbar: t.contains(b), shown: r.width > 0, btn: b.classList.contains('btn') }; })()`);
            assert.deepEqual(copy, { inToolbar: true, shown: true, btn: true }, at + 'Copy docs line for agents is a normal button in the page header');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('docs-page'), ${SCALE})`), [], at + "every text of a topic's page is on the scale");
            await shot(`docs-one-topic-${w}`);
            await ev(`document.getElementById('docs-back').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'back is the table', 8000);

            // the chevron folds without opening a table; the name opens it again
            await ev(`document.querySelector('${pane('docs')} .sgroup-header[data-group-name="docs:api"] .group-chevron').click(); true`);
            assert.equal(await ev(`document.querySelector('${pane('docs')} .sgroup-header[data-group-name="docs:api"] .group-chevron').getAttribute('aria-expanded')`), 'false', at + 'the chevron folds API');
            assert.equal(await ev(`document.querySelectorAll('${pane('docs')} li .row-btn').length`), counts[0], at + "API's topics are hidden");
            await ev(`document.querySelector('${pane('docs')} .sgroup-header[data-group-name="docs:api"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'API'`, at + "the name opens API's table", 8000);
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr').length`), counts[1], at + "all of API's topics are in its table, folded or not");
            await ev(`document.querySelector('${pane('docs')} .sgroup-header[data-group-name="docs:api"] .group-chevron').click(); true`); // open it again

            // the search narrows the topics
            await ev(`(() => { const i = document.querySelector('${pane('docs')} .sidebar-search-input'); i.value = 'quickstart'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('${pane('docs')} li .row-btn').length > 0 && document.querySelectorAll('${pane('docs')} li .row-btn').length < ${counts[0] + counts[1]}`, at + 'the search narrows the list', 5000);
            assert.ok(await ev(`[...document.querySelectorAll('${pane('docs')} li .row-btn')].every(b => /quickstart/i.test(b.textContent))`), at + 'only matching topics');
            await ev(`(() => { const i = document.querySelector('${pane('docs')} .sidebar-search-input'); i.value = 'zzzzzz'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('${pane('docs')} .empty-state')`, at + 'no match says so', 5000);
            await ev(`(() => { const i = document.querySelector('${pane('docs')} .sidebar-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('${pane('docs')} li .row-btn').length === ${counts[0] + counts[1]}`, at + 'cleared: every topic is back', 5000);

            // both themes and 200% text: contrast, inside the screen
            if (w === 1280) for (const theme of ['dark', 'light']) for (const zoom of ['', '32px']) {
                const how = at + `${theme}${zoom ? ', 200% text' : ''}: `;
                await setTheme(ev, theme); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                await ev(`document.querySelector('${pane('docs')} .sgroup-header').click(); true`);
                await waitFor(`document.getElementById('group-table-view').checkVisibility()`, how + 'the table', 8000);
                const au = await auditRegion(ev, ['.sidebar', '#group-table-view']);
                assert.deepEqual(au.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + 'the sidebar and the table: contrast');
                await shot(`docs-table-${theme}${zoom ? '-200' : ''}`);
                await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
                await waitFor(`!!document.querySelector('#docs-content h1')`, how + 'a topic', 8000);
                const au2 = await auditRegion(ev, ['#docs-page']);
                assert.deepEqual(au2.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + "a topic's page: contrast");
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, how + 'no sideways scroll');
                const cut = await ev(`(() => { const b = document.getElementById('docs-copy-agent-line').getBoundingClientRect(); return b.right > innerWidth || b.left < 0; })()`);
                assert.equal(cut, false, how + 'the copy button is on screen');
            }
            await setTheme(ev, 'dark'); await ev(`document.documentElement.style.fontSize = ''; true`);
        }
        console.log('PASS docs one sidebar: groups, tables, topic pages at the reading scale, search, phone screens');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
