// The agent's side panel tabs say their words (UI/UX's 170 list, item 1, #7621): when all the words fit the row on one line each tab shows its word beside its icon (a panel dragged narrow, or text at 200%, falls back to
// icons alone: no word clipped, no wrapped row), the Tasks count stays a badge, and when even the icons do not fit the LAST tabs go under More at the END of the row (#21684; dock_tabs_stable_browser holds that they never move
// on a pick or a count). More opens with the keyboard and lights when the open tab is behind it. Drives the real dashboard over CDP; an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ tabLayout: '{"agent":{"order":[],"hidden":["board","info","saved"]}}' });
    const { Input } = client;
    const key = async k => { const vk = { ArrowDown: 40, ArrowUp: 38, Escape: 27, Enter: 13, Tab: 9 }[k]; for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && k === 'Enter' ? { text: '\r' } : {}) }); };
    const ok = name => console.log(`   ✓ ${name}`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const ROW = '#agentic-block-top .agentic-state-tabs';
    const row = () => ev(`(() => { const r = document.querySelector('${ROW}'); const tabs = [...r.querySelectorAll('.agentic-tab')].filter(b => getComputedStyle(b).display !== 'none' && !b.classList.contains('tab-more') && !b.classList.contains('agentic-tab-close'));
        const word = b => { const w = b.querySelector('.agentic-tab-word'); return w && getComputedStyle(w).display !== 'none' ? w.textContent : null; };
        return { words: r.hasAttribute('data-words'), shown: tabs.map(b => [b.dataset.tab || b.id.replace('agentic-tab-', ''), word(b)]), tops: [...new Set(tabs.map(b => b.offsetTop))], clipped: r.scrollWidth > r.clientWidth, more: (() => { const m = document.getElementById('agentic-tab-more'); return m.hidden ? null : [m.getAttribute('aria-label'), m.classList.contains('active'), m.getAttribute('aria-expanded')]; })() }; })()`);
    const load = async (w, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__m.add('dock-bot', 'A', 3, { sleeping: false }); true`);
        await settle(ev, 600); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('dock-bot', 'claude', 'dock-bot-id', 'local'); true`);
        await ev(`(() => { const p = document.getElementById('agentic-state'); if (p.classList.contains('collapsed') || document.getElementById('agentic-tab-files').getBoundingClientRect().width === 0) window.toggleAgenticPanel(true); return true; })()`);
        await waitFor(`document.getElementById('agentic-tab-files').getBoundingClientRect().width > 0`, 'the panel', 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        console.log('1280: every tab named, one line, nothing clipped, More last');
        await load(1280, false);
        await settle(ev, 500); // sleep-ok: the row is measured over a few frames
        let r = await row();
        const named = r.shown.filter(([t]) => t !== 'customize' && t !== 'more'); // the Customize button at the row's end is an icon alone, as it was
        assert.ok(named.length >= 3 && named[0][0] === 'files', 'the tabs are in the row in order: ' + JSON.stringify(r.shown));
        assert.deepEqual([r.tops.length, r.clipped], [1, false], 'one line, nothing clipped: ' + JSON.stringify(r));
        assert.ok(await ev(`[...document.querySelectorAll('${ROW} .agentic-tab')].filter(b => getComputedStyle(b).display !== 'none' && !b.classList.contains('tab-more')).every(b => b.title && b.getAttribute('aria-label'))`), 'every tab has its title and aria-label');
        assert.ok(r.more === null || r.shown.map(x => x[0]).slice(-2)[0] === 'more', 'More is the last tab of the row, before Customize: ' + JSON.stringify(r.shown));
        ok('the tabs in order on one line, More last');
        await shot('dock-tabs-1280');

        // UI/UX's #7621 small points: the customizer icon is named, only the selected tab looks selected (a hovered one is not blue with an underline), and the files line is sentence case
        assert.deepEqual(await ev(`(() => { const b = document.getElementById('agentic-tab-customize'); return [b.title, b.getAttribute('aria-label')]; })()`), ['Customize tabs', 'Customize tabs'], 'the customizer icon is named Customize tabs');
        const hot = await ev(`(() => { const sa = document.getElementById('agentic-tab-saved').getBoundingClientRect(); return { x: sa.left + sa.width / 2, y: sa.top + sa.height / 2 }; })()`);
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: hot.x, y: hot.y });
        await waitFor(`!document.getAnimations().some(a => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('${ROW}'))`, 'the tabs have finished their colour transition', 4000);
        const look = await ev(`(() => { const st = id => { const c = getComputedStyle(document.getElementById('agentic-tab-' + id)); return [c.color, c.borderBottomColor, document.getElementById('agentic-tab-' + id).classList.contains('active')]; }; return { files: st('files'), saved: st('saved'), active: [...document.querySelectorAll('${ROW} .agentic-tab.active')].map(b => b.dataset.tab) }; })()`);
        assert.deepEqual(look.active, ['files'], 'one tab is selected: ' + JSON.stringify(look));
        assert.ok(look.saved[1] !== look.files[1] && !/^rgba\(0, 0, 0, 0\)$/.test(look.files[1]) && /^rgba\(\d+, \d+, \d+, (0|0\.0\d*)\)$|^rgba\(0, 0, 0, 0\)$/.test(look.saved[1]), 'a hovered tab is not drawn as the selected one (no accent underline; the tab family draws both in the primary text colour): ' + JSON.stringify(look));
        assert.equal(await ev(`getComputedStyle(document.getElementById('changed-files-title')).textTransform`), 'none', 'the files line is not in capitals');
        ok('Customize tabs, one selected tab, sentence case');
        console.log('More opens the tabs behind it');
        await ev(`(() => { const s = document.getElementById('agentic-state'); s.style.setProperty('width', '300px', 'important'); s.style.setProperty('max-width', '300px', 'important'); return true; })()`);
        await waitFor(`!document.getElementById('agentic-tab-more').hidden`, 'More appears when the icons do not fit the row', 5000);
        await settle(ev, 300); // sleep-ok: the row is measured over a few frames
        const rowBefore = (await row()).shown.map(x => x[0]).join();
        await ev(`document.getElementById('agentic-tab-more').focus(); true`);
        await key('ArrowDown');
        await waitFor(`!document.getElementById('agentic-more-menu').hidden && document.activeElement.getAttribute('role') === 'menuitem'`, 'the menu opens on ArrowDown with the focus in it', 4000);
        const items = await ev(`[...document.querySelectorAll('#agentic-more-menu [role=menuitem]')].map(i => i.dataset.tab)`);
        assert.ok(items.length >= 2, 'the menu holds the last tabs: ' + JSON.stringify(items));
        assert.equal(await ev(`document.activeElement.dataset.tab`), items[0], 'the menu opens on its first item');
        await shot('dock-tabs-more-open');
        await key('ArrowDown'); await key('Enter'); // the menu opens on its first item: one step down is the second
        await waitFor(`document.getElementById('agentic-panel-' + ${JSON.stringify(items[1])}).classList.contains('active')`, `Enter opens ${items[1]}`, 4000);
        r = await row();
        assert.deepEqual(r.more, ['More tabs', true, 'false'], 'More stays More, and lights: the open tab is behind it: ' + JSON.stringify(r.more));
        assert.equal(await ev(`document.querySelector('#agentic-tab-more .agentic-tab-word').textContent`), 'More', 'and says More');
        assert.equal(r.shown.map(x => x[0]).join(), rowBefore, 'the row did not change: ' + JSON.stringify(r.shown));
        assert.equal(await ev(`document.getElementById('agentic-menu') === null && document.getElementById('agentic-more-menu').hidden`), true, 'the menu closed');
        await ev(`document.getElementById('agentic-tab-more').focus(); true`); await key('ArrowDown'); await key('Escape');
        assert.equal(await ev(`document.activeElement.id`), 'agentic-tab-more', 'Escape closes the menu with the focus back on More');
        await ev(`document.getElementById('agentic-tab-files').click(); true`);
        r = await row(); assert.deepEqual([r.more[0], r.more[1]], ['More tabs', false], 'a tab of the row: More is not lit');
        ok('the keyboard opens, picks and closes; the open tab stays behind More and lights it');
        await ev(`(() => { const s = document.getElementById('agentic-state'); s.style.removeProperty('width'); s.style.removeProperty('max-width'); return true; })()`);

        console.log('a wide count crowds the row: icons alone, nothing clipped');
        // #9999 (the beta tester: eight icon-only tabs, a newcomer guessed which was Artifacts): the words are off, but the open tab says its own word when that fits; the others stay icons.
        let sawWord = false;
        await ev(`document.getElementById('agentic-tab-files').click(); true`);
        for (const n of [4, 6, 8, 10, 11, 12, 13, 14, 16, 18]) { // a Files count of n digits widens its tab step by step, Files open
            await ev(`document.getElementById('files-bar-count').textContent = '8'.repeat(${n}); window.dispatchEvent(new Event('resize')); true`); await settle(ev, 400); // sleep-ok: the row is measured again
            r = await row();
            if (r.words) continue; // every word fits
            const said = r.shown.filter(([, x]) => x !== null);
            assert.ok(r.tops.length === 1 && !r.clipped && said.length <= 1 && (said.length === 0 || said[0][0] === 'files'), `a ${n}-digit count: icons, and at most the open tab with its word, one line, nothing clipped: ` + JSON.stringify(r));
            if (!sawWord) await shot('dock-tabs-open-word'); sawWord = true; // (that the open Files tab says its word when only it fits is dock_files_word_browser's)
        }
        assert.ok(sawWord, 'the words give way to icons when a wide count crowds the row');
        await settle(ev, 200); r = await row(); // sleep-ok: the row is measured for the name check
        assert.ok(await ev(`[...document.querySelectorAll('${ROW} .agentic-tab')].filter(b => getComputedStyle(b).display !== 'none' && !b.classList.contains('tab-more')).every(b => b.getAttribute('aria-label') && b.title)`), 'each keeps its name as aria-label and title');
        await shot('dock-tabs-narrow'); ok('words fall back to icons with the names kept');
        await ev(`document.getElementById('files-bar-count').textContent = ''; document.getElementById('agentic-tab-files').click(); true`);

        console.log('200% text: icons alone, the row does not wrap');
        await ev(`document.documentElement.style.fontSize = '32px'; true`);
        await settle(ev, 400); // sleep-ok: layout settles over frames after a font-size change
        r = await row();
        assert.ok(r.shown.every(([, w]) => w === null) || (r.tops.length === 1 && !r.clipped), 'words only if they fit: ' + JSON.stringify(r));
        await ev(`document.documentElement.style.fontSize = ''; true`);

        console.log('below 1280 and on the phone: one line, nothing clipped, More last when the icons do not fit');
        await load(1100, false);
        await waitFor(`(() => { const rw = document.querySelector('${ROW}'); return rw.scrollWidth <= rw.clientWidth; })()`, 'the row has settled: the words on, or taken off, with nothing clipped', 4000);
        r = await row(); assert.ok(r.tops.length === 1 && !r.clipped, 'one line, nothing clipped at 1100: ' + JSON.stringify(r));
        await load(390, true);
        // the phone's strip scrolls (#17242), so settled means the words are on or off, not that the row fits
        await waitFor(`(() => { const rw = document.querySelector('${ROW}'); return rw.dataset.words !== undefined || rw.scrollWidth <= rw.clientWidth; })()`, 'the row has settled: the words on, or taken off, with nothing clipped', 4000);
        r = await row(); assert.ok(r.more && r.tops.length === 1, 'the phone: one line, More for the last tabs: ' + JSON.stringify(r));
        await ev(`document.getElementById('agentic-tab-more').click(); true`);
        await waitFor(`!document.getElementById('agentic-more-menu').hidden`, 'More opens on the phone', 4000);
        const target = await ev(`Math.round(document.querySelector('#agentic-more-menu [role=menuitem]').getBoundingClientRect().height)`);
        assert.ok(target >= 44, 'a 44 px target on the phone: ' + target);
        await shot('dock-tabs-more-390'); ok('below 1280 and on the phone');
        // a tab chosen from More shows its word on the More button: the strip still holds every tab, none cut at its edge (#10052, Mobile tester)
        const before = await ev(`(() => { const r = document.querySelector('${ROW}'); return r.scrollWidth - r.clientWidth; })()`);
        await ev(`document.querySelector('#agentic-more-menu [role=menuitem]').click(); true`); await settle(ev, 400); // sleep-ok: the tab switch redraws the strip
        const fit = await ev(`(() => { const r = document.querySelector('${ROW}'), rb = r.getBoundingClientRect(); const tabs = [...r.querySelectorAll('.agentic-tab')].filter(b => getComputedStyle(b).display !== 'none' && b.getClientRects().length); const out = tabs.filter(b => { const b2 = b.getBoundingClientRect(); return b2.right > rb.right + 1 || b2.left < rb.left - 1; }).map(b => (b.getAttribute('aria-label') || b.title || b.id)); return { n: tabs.length, out, scroll: r.scrollWidth - r.clientWidth, before: window.__before, more: (document.getElementById('agentic-tab-more') || {}).textContent }; })()`);
        assert.equal(await ev(`document.getElementById('agentic-tab-more').classList.contains('active')`), true, 'the tab picked from More stays behind it and More is lit (#21684)');
        assert.equal(await ev(`document.getElementById('agentic-tab-more').getClientRects().length > 0 && document.querySelector('#agentic-tab-more .agentic-tab-word').textContent`), 'More', 'More is still there after the pick');
        await shot('dock-tabs-open-word-390');
        // a tab's new count widens the tabs and leaves the strip's size alone (it does not wrap while its words show, #9420): the tabs are watched, so the words come off and nothing is wrapped or clipped (#9435)
        await ev(`document.getElementById('agentic-tab-files').click(); true`); // the picked tab stays open across the reload and is a tab of the row now (#15733): Files is the one the words were measured with
        await load(1280, false);
        await ev(`for (const b of document.querySelectorAll('${ROW} .agentic-tab[data-tab]')) if (!['files', 'artifacts', 'tasks'].includes(b.dataset.tab)) b.classList.add('tab-hidden'); true`); // a page with three tabs: their words fit (the customizer's own hiding)
        await waitFor(`document.querySelector('${ROW}').hasAttribute('data-words')`, 'the words show again at 1280', 4000);
        // A layout-only badge uses the real count's classes, without the Files list replacing its text on refresh (#12683).
        await ev(`(() => { const badge = document.getElementById('files-bar-count').cloneNode(false); badge.removeAttribute('id'); badge.textContent = '8'.repeat(32); document.getElementById('agentic-tab-files').append(badge); return true; })()`);
        await waitFor(`!document.querySelector('${ROW}').hasAttribute('data-words')`, 'the words give way when the count widens the tabs', 4000);
        r = await row();
        assert.ok(r.tops.length === 1 && !r.clipped, 'wide counts: icons alone, one line, nothing clipped: ' + JSON.stringify(r));
        ok('a count that widens the tabs takes the words off: one line, nothing clipped');
        // coral-hub's UI review of the Branches tab: after a pick from More the focus is on a visible target, the opened panel (named for its tab), never body or the menu
        // item that went with the menu; Tab and Shift-Tab then move between visible controls. At 1280 and at 390 (phone).
        const seen = () => ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return { id: 'body' }; const r = a.getBoundingClientRect();
            return { id: a.id || a.tagName.toLowerCase(), role: a.getAttribute('role') || '', label: a.getAttribute('aria-label') || '', visible: r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden' }; })()`);
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            console.log(`${w}: the focus after a pick from More`);
            await load(w, mobile);
            await ev(`(() => { const s = document.getElementById('agentic-state'); s.style.setProperty('width', '300px', 'important'); s.style.setProperty('max-width', '300px', 'important'); return true; })()`); // a narrow row: the last tabs, Branches among them, are behind More
            await waitFor(`!!document.querySelector('#agentic-more-menu [data-tab=branches]')`, `${w}: Branches is behind More`, 5000);
            await ev(`document.getElementById('agentic-tab-files').click(); true`); await waitFor(`document.getElementById('agentic-panel-files').classList.contains('active') && !document.querySelector('#agentic-more-menu [data-tab=branches]') === false`, 'Files is open and Branches is behind More again', 4000); // the open tab stays across a reload and is in the row now (#15733), so Branches is picked from More only when another tab is open
            await ev(`document.getElementById('agentic-tab-more').focus(); true`);
            await key('ArrowDown');
            await waitFor(`!document.getElementById('agentic-more-menu').hidden`, 'the menu opens', 4000);
            for (let i = 0; i < 6 && !(await ev(`document.activeElement && document.activeElement.dataset.tab === 'branches'`)); i++) await key('ArrowDown');
            await key('Enter');
            await waitFor(`document.getElementById('agentic-panel-branches').classList.contains('active')`, 'Enter opens Branches', 4000);
            const after = await seen();
            assert.deepEqual([after.id, after.label, after.visible], ['agentic-panel-branches', 'Branches', true], `${w}: the focus is on the Branches panel, named and visible: ` + JSON.stringify(after));
            // the visible tab stops after the panel in document order: with none (the panel is the page's last stop) Tab leaves the page, as the browser does past the last control
            const stopsAfter = await ev(`(() => { const p = document.getElementById('agentic-panel-branches'); const sel = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
                return [...document.querySelectorAll(sel)].filter(e => !e.disabled && (p.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && !p.contains(e) && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden').length; })()`);
            await key('Tab');
            const next = await seen();
            if (stopsAfter) assert.ok(next.id !== 'body' && next.visible, `${w}: Tab from the panel goes to a visible control (${stopsAfter} follow it): ` + JSON.stringify(next));
            else {
                // past the last control the browser either leaves the page (focus on the body) or, once it has left it earlier in the same session, wraps to the page's first stop (the skip link): both leave the panel, neither lands on a hidden control (#15006)
                const first = await ev(`(() => { const e = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].find(e => !e.disabled && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden'); return e === document.activeElement; })()`);
                assert.ok(next.id === 'body' || first, `${w}: the panel is the last tab stop, so Tab leaves the page or wraps to the first stop: ` + JSON.stringify(next));
            }
            await ev(`document.getElementById('agentic-panel-branches').focus(); true`);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
            const prev = await seen();
            assert.ok(prev.id !== 'body' && prev.visible, `${w}: Shift-Tab from the panel goes to a visible control: ` + JSON.stringify(prev));
            ok(`${w}: picking Branches puts the focus on its panel; Tab goes to ${stopsAfter ? next.id : 'outside the page (the panel is the last stop)'}, Shift-Tab to ${prev.id}`);
        }
        console.log('PASS dock tabs');
    } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; }
    try { await client.close(); } catch (_) {}
})();
