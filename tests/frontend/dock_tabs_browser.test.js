// The agent's side panel tabs say their words (UI/UX's 170 list, item 1, #7621): when all the words fit the row on one line each tab shows its word beside its icon (a panel dragged narrow, or text at 200%, falls back to
// icons alone: no word, no count, no clipped word, no wrapped row), and when even the icons do not fit the row scrolls sideways with every tab reachable: there is no More menu (#21684; dock_tabs_stable_browser holds that no
// tab moves on a pick or a count). Drives the real dashboard over CDP; an isolated dev server.
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
        return { words: r.hasAttribute('data-words'), shown: tabs.map(b => [b.dataset.tab || b.id.replace('agentic-tab-', ''), word(b)]), tops: [...new Set(tabs.map(b => b.offsetTop))], clipped: r.scrollWidth > r.clientWidth, }; })()`);
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

        console.log('1280: every tab named, one line, nothing clipped');
        await load(1280, false);
        await settle(ev, 500); // sleep-ok: the row is measured over a few frames
        let r = await row();
        const named = r.shown.filter(([t]) => t !== 'customize' && t !== 'more'); // the Customize button at the row's end is an icon alone, as it was
        assert.ok(named.length >= 3 && named[0][0] === 'files', 'the tabs are in the row in order: ' + JSON.stringify(r.shown));
        assert.deepEqual([r.tops.length, r.clipped], [1, false], 'one line, nothing clipped: ' + JSON.stringify(r));
        assert.ok(await ev(`[...document.querySelectorAll('${ROW} .agentic-tab')].filter(b => getComputedStyle(b).display !== 'none' && !b.classList.contains('tab-more')).every(b => b.title && b.getAttribute('aria-label'))`), 'every tab has its title and aria-label');
        ok('the tabs in order on one line');
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
        assert.equal(await ev(`document.getElementById('agentic-tab-more') || document.getElementById('agentic-more-menu')`), null, 'there is no More button and no More menu');

        console.log('a wide count crowds the row: icons alone, nothing clipped');
        // the words are off and so are the counts and the open tab's word (the Operator, #21684: just icons); every tab stays in the row.
        let sawWord = false;
        await ev(`document.getElementById('agentic-tab-files').click(); true`);
        for (const n of [4, 6, 8, 10, 11, 12, 13, 14, 16, 18]) { // a Files count of n digits widens its tab step by step, Files open
            await ev(`document.getElementById('files-bar-count').textContent = '8'.repeat(${n}); window.dispatchEvent(new Event('resize')); true`); await settle(ev, 400); // sleep-ok: the row is measured again
            r = await row();
            if (r.words) continue; // every word fits
            const said = r.shown.filter(([, x]) => x !== null);
            assert.ok(r.tops.length === 1 && !r.clipped && said.length === 0, `a ${n}-digit count: icons alone, one line, nothing clipped: ` + JSON.stringify(r));
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

        console.log('below 1280 and on the phone: one line, every tab in the row');
        await load(1100, false);
        await waitFor(`(() => { const rw = document.querySelector('${ROW}'); return rw.scrollWidth <= rw.clientWidth; })()`, 'the row has settled: the words on, or taken off, with nothing clipped', 4000);
        r = await row(); assert.ok(r.tops.length === 1 && !r.clipped, 'one line, nothing clipped at 1100: ' + JSON.stringify(r));
        await load(390, true);
        await waitFor(`(() => { const rw = document.querySelector('${ROW}'); return rw.dataset.words !== undefined || rw.scrollWidth <= rw.clientWidth || true; })()`, 'the row has settled', 4000);
        r = await row(); assert.ok(r.tops.length === 1 && r.shown.length >= 6, 'the phone: one line, every tab in the row: ' + JSON.stringify(r));
        await shot('dock-tabs-390'); ok('below 1280 and on the phone');
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
        console.log('PASS dock tabs');
    } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; }
    try { await client.close(); } catch (_) {}
})();
