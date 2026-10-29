// The agent's side panel tabs say their words (UI/UX's 170 list, item 1, #7621): at 1280 px and up each tab shows its word beside its icon when all the words fit the row on one line (a panel dragged
// narrow, or text at 200%, falls back to icons alone: no word clipped, no wrapped row), the Tasks count stays a badge, and the three rarely used tabs (Browse, Activity, Agent UI) are behind one More menu that
// opens them with the keyboard and carries the open one's word. Below 1280 the tabs are icons alone with their names as title and aria-label. Drives the real dashboard over CDP; an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
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
        await ev(`localStorage.removeItem('coral-agentic-tab-prefs'); window.__m.add('dock-bot', 'A', 3, { sleeping: false }); true`);
        await settle(ev, 600); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('dock-bot', 'claude', 'dock-bot-id', 'local'); true`);
        await ev(`(() => { const p = document.getElementById('agentic-state'); if (p.classList.contains('collapsed') || document.getElementById('agentic-tab-files').getBoundingClientRect().width === 0) window.toggleAgenticPanel(true); return true; })()`);
        await waitFor(`document.getElementById('agentic-tab-files').getBoundingClientRect().width > 0 && !document.getElementById('agentic-tab-more').hidden`, 'the panel and its More', 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });

        console.log('1280: words when they all fit');
        await load(1280, false);
        await waitFor(`document.querySelector('${ROW}').hasAttribute('data-words')`, 'the words show at the default panel width', 4000);
        let r = await row();
        const named = r.shown.filter(([t]) => t !== 'customize'); // the Customize button at the row's end is an icon alone, as it was
        assert.deepEqual(named.map(([t, w]) => [t, w]), [['files', 'Files'], ['artifacts', 'Artifacts'], ['tasks', 'Tasks'], ['notes', 'Notes'], ['saved', 'Saved'], ['more', 'More']], 'each shown tab says its word: ' + JSON.stringify(r.shown));
        assert.deepEqual([r.tops.length, r.clipped], [1, false], 'one line, nothing clipped: ' + JSON.stringify(r));
        assert.ok(!r.shown.some(([t]) => ['browse', 'activity', 'agent-ui'].includes(t)), 'the three rare tabs are not in the row: ' + JSON.stringify(r.shown));
        assert.equal(r.more[0], 'More tabs'); ok('Files, Artifacts, Tasks, Notes, Saved and More with their words, on one line');
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
        console.log('More opens the rare tabs');
        await ev(`document.getElementById('agentic-tab-more').focus(); true`);
        await key('ArrowDown');
        await waitFor(`!document.getElementById('agentic-more-menu').hidden && document.activeElement.getAttribute('role') === 'menuitem'`, 'the menu opens on ArrowDown with the focus in it', 4000);
        const items = await ev(`[...document.querySelectorAll('#agentic-more-menu [role=menuitem]')].map(i => i.dataset.tab + ':' + i.textContent.trim())`);
        assert.deepEqual(items, ['browse:folder_openBrowse', 'activity:timelineActivity', 'agent-ui:widgetsAgent UI'], JSON.stringify(items));
        await shot('dock-tabs-more-open');
        await key('ArrowDown'); await key('Enter');
        await waitFor(`document.getElementById('agentic-panel-activity').classList.contains('active')`, 'Enter opens Activity', 4000);
        r = await row();
        assert.deepEqual(r.more, ['More: Activity, open', true, 'false'], 'More carries the open tab: ' + JSON.stringify(r.more));
        assert.equal(await ev(`document.querySelector('#agentic-tab-more .agentic-tab-word').textContent`), 'Activity', 'and says its word');
        assert.equal(await ev(`document.getElementById('agentic-menu') === null && document.getElementById('agentic-more-menu').hidden`), true, 'the menu closed');
        await ev(`document.getElementById('agentic-tab-more').focus(); true`); await key('ArrowDown'); await key('Escape');
        assert.equal(await ev(`document.activeElement.id`), 'agentic-tab-more', 'Escape closes the menu with the focus back on More');
        await ev(`document.getElementById('agentic-tab-files').click(); true`);
        r = await row(); assert.deepEqual([r.more[0], r.more[1]], ['More tabs', false], 'another tab: More says More again');
        ok('the keyboard opens, picks and closes; the open rare tab is seen on More');

        console.log('a panel dragged narrow: icons alone');
        await ev(`document.getElementById('agentic-state').style.width = '300px'; window.dispatchEvent(new Event('resize')); true`);
        await waitFor(`!document.querySelector('${ROW}').hasAttribute('data-words')`, 'the words give way when they do not fit', 4000);
        r = await row();
        // #9999 (the beta tester: eight icon-only tabs, a newcomer guessed which was Artifacts): the words are off, but the open tab says its own word when that fits, whichever tab is open; the others stay icons
        let sawWord = false;
        for (const w of [300, 340, 380, 420, 460]) {
            await ev(`document.getElementById('agentic-state').style.width = '${w}px'; window.dispatchEvent(new Event('resize')); true`); await settle(ev, 400); // sleep-ok: the row is measured again
            for (const tab of ['files', 'artifacts', 'tasks']) {
                await ev(`document.getElementById('agentic-tab-${tab}').click(); true`); await settle(ev, 300); // sleep-ok: the tab switches
                r = await row();
                if (r.words) continue; // every word fits: the 1280 case above
                const said = r.shown.filter(([, x]) => x !== null);
                assert.ok(r.tops.length === 1 && !r.clipped && said.length <= 1 && (said.length === 0 || said[0][0] === tab), `${w} px: icons, and at most the open tab (${tab}) with its word, one line, nothing clipped: ` + JSON.stringify(r));
                if (said.length === 1) { if (!sawWord) await shot('dock-tabs-open-word'); sawWord = true; }
            }
        }
        assert.ok(sawWord, 'at some width where the words do not all fit, the open tab says its word');
        await ev(`document.getElementById('agentic-tab-files').click(); true`); await settle(ev, 300); r = await row(); // sleep-ok: back to Files
        await ev(`document.getElementById('agentic-state').style.width = '300px'; window.dispatchEvent(new Event('resize')); true`); await settle(ev, 400); r = await row(); // sleep-ok: back to the narrow panel
        assert.ok(await ev(`[...document.querySelectorAll('${ROW} .agentic-tab')].filter(b => getComputedStyle(b).display !== 'none' && !b.classList.contains('tab-more')).every(b => b.getAttribute('aria-label') && b.title)`), 'each keeps its name as aria-label and title');
        await shot('dock-tabs-narrow'); ok('words fall back to icons with the names kept');
        await ev(`document.getElementById('agentic-state').style.width = ''; true`);

        console.log('200% text: icons alone, the row does not wrap');
        await ev(`document.documentElement.style.fontSize = '32px'; true`);
        await settle(ev, 400); // sleep-ok: layout settles over frames after a font-size change
        r = await row();
        assert.ok(r.shown.every(([, w]) => w === null) || (r.tops.length === 1 && !r.clipped), 'words only if they fit: ' + JSON.stringify(r));
        await ev(`document.documentElement.style.fontSize = ''; true`);

        console.log('below 1280: icons alone; the phone has More too');
        await load(1100, false);
        r = await row(); assert.ok(!r.words && r.shown.every(([, w]) => w === null), 'icons alone below 1280: ' + JSON.stringify(r));
        await load(390, true);
        r = await row(); assert.ok(r.more && r.shown.every(([, w]) => w === null), 'the phone: icons, and More: ' + JSON.stringify(r));
        await ev(`document.getElementById('agentic-tab-more').click(); true`);
        await waitFor(`!document.getElementById('agentic-more-menu').hidden`, 'More opens on the phone', 4000);
        const target = await ev(`Math.round(document.querySelector('#agentic-more-menu [role=menuitem]').getBoundingClientRect().height)`);
        assert.ok(target >= 44, 'a 44 px target on the phone: ' + target);
        await shot('dock-tabs-more-390'); ok('below 1280 and on the phone');
        // a tab chosen from More shows its word on the More button: the strip still holds every tab, none cut at its edge (#10052, Mobile tester)
        const before = await ev(`(() => { const r = document.querySelector('${ROW}'); return r.scrollWidth - r.clientWidth; })()`);
        await ev(`document.querySelector('#agentic-more-menu [role=menuitem]').click(); true`); await settle(ev, 400); // sleep-ok: the tab switch redraws the strip
        const fit = await ev(`(() => { const r = document.querySelector('${ROW}'), rb = r.getBoundingClientRect(); const tabs = [...r.querySelectorAll('.agentic-tab')].filter(b => getComputedStyle(b).display !== 'none' && b.getClientRects().length); const out = tabs.filter(b => { const b2 = b.getBoundingClientRect(); return b2.right > rb.right + 1 || b2.left < rb.left - 1; }).map(b => (b.getAttribute('aria-label') || b.title || b.id)); return { n: tabs.length, out, scroll: r.scrollWidth - r.clientWidth, before: window.__before, more: (document.getElementById('agentic-tab-more') || {}).textContent }; })()`);
        assert.ok(fit.scroll <= before, 'the open tab\'s word does not widen the row past what it was (' + before + ' px over before, ' + fit.scroll + ' after)');
        assert.deepEqual(fit.out.filter(() => fit.scroll > before), [], 'no tab is cut at the strip\'s edge when the open tab shows its word at 390: ' + JSON.stringify(fit));
        await shot('dock-tabs-open-word-390');
        // a tab's new count widens the tabs and leaves the strip's size alone (it does not wrap while its words show, #9420): the tabs are watched, so the words come off and nothing is wrapped or clipped (#9435)
        await load(1280, false);
        await waitFor(`document.querySelector('${ROW}').hasAttribute('data-words')`, 'the words show again at 1280', 4000);
        await ev(`for (const id of ['files-bar-count', 'task-bar-count', 'note-bar-count']) document.getElementById(id).textContent = '88888888'; true`);
        await waitFor(`!document.querySelector('${ROW}').hasAttribute('data-words')`, 'the words give way when the counts widen the tabs', 4000);
        r = await row();
        assert.ok(r.tops.length === 1 && !r.clipped, 'wide counts: icons alone, one line, nothing clipped: ' + JSON.stringify(r));
        ok('a count that widens the tabs takes the words off: one line, nothing clipped');
        console.log('PASS dock tabs');
    } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; }
    try { await client.close(); } catch (_) {}
})();
