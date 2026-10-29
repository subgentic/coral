// UI polish from QA's Windows walkthrough (#290; a fresh redo of #129 on main): the "Skip to main content" link is the page's first stop, a shortened path keeps the
// end of a Windows path, and a folder group's long name ends in an ellipsis with the whole name as its title, as a team's does. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const STATIC = "(window.__coralStatic || '/static/')";

const LONG = 'a-folder-name-long-enough-to-run-past-any-sidebar-width-there-is';
const SESSIONS = [{ session_id: 'f-1', name: LONG, display_name: 'Solo', agent_type: 'claude', working_directory: 'D:\\work\\' + LONG, sleeping: false }];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setFocusEmulationEnabled({ enabled: true }); // a page nobody is looking at has no focus, so :focus would match nothing
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);

        console.log('the skip link is the first stop, is a 44 px target when focused, and moves the focus to the main area');
        const skip = await ev(`(() => {
            const a = document.querySelector('.skip-main');
            if (!a) return null;
            const first = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].find(e => e.tabIndex >= 0 && !e.closest('[hidden]') && e.getClientRects().length);
            const before = location.href;
            a.focus(); const shown = a.getBoundingClientRect();
            a.click();
            return { isFirst: first === a, onScreen: shown.top >= 0 && shown.left >= 0, height: shown.height, focusedMain: document.activeElement && document.activeElement.id === 'main-stage', sameAddress: location.href === before, text: a.textContent.trim() };
        })()`);
        assert.ok(skip, 'there is a skip link');
        assert.equal(skip.text, 'Skip to main content');
        assert.ok(skip.isFirst, 'it is the first stop');
        assert.ok(skip.onScreen, 'it is on screen when it has the focus');
        assert.ok(skip.height >= 44, 'a touch target of at least 44 px: ' + skip.height);
        assert.ok(skip.focusedMain, 'activating it focuses the main area');
        assert.ok(skip.sameAddress, 'without changing the address (the hash is a route)');
        // activating it moved the focus to the main area, so the link has hidden itself again
        assert.equal(await ev(`document.querySelector('.skip-main').getBoundingClientRect().bottom <= 0`), true, 'off screen once the focus has moved on');
        assert.equal(await ev(`(() => { const a = document.querySelector('.skip-main'); a.focus(); return a.getBoundingClientRect().bottom > 0; })()`), true, 'shown again when it has the focus');
        await ev(`document.querySelector('.skip-main').blur(); true`);

        console.log('a shortened path keeps its end, on Windows too');
        const paths = await ev(`(async () => { const m = await import(${STATIC} + 'session_state.js'); return {
            win: m._shortPath('D:\\\\software\\\\coral\\\\José Ñúñez\\\\Proyecto largo', 2),
            slashes: m._shortPath('C:/Users/x/work/repo/sub', 2),
            unc: m._shortPath('\\\\\\\\host\\\\share\\\\a\\\\b\\\\c', 2),
            short: m._shortPath('C:\\\\work', 2),
            trailing: m._shortPath('D:\\\\a\\\\b\\\\c\\\\', 2),
            posix: m._shortPath('/Users/me/work/repo/sub', 2),
            home: m._shortPath('/home/me/a/b/c', 2) }; })()`);
        assert.equal(paths.win, '…\\José Ñúñez\\Proyecto largo');
        assert.equal(paths.slashes, '…\\repo\\sub', 'a Windows path written with slashes is cut on either');
        assert.equal(paths.unc, '…\\b\\c');
        assert.equal(paths.short, 'C:\\work', 'a short path is left whole');
        assert.equal(paths.trailing, '…\\b\\c', 'a trailing separator does not count');
        assert.equal(paths.posix, '…/repo/sub', 'a POSIX path is unchanged');
        assert.equal(paths.home, '…/b/c');

        console.log("a folder group's long name ends in an ellipsis, with the whole name as its title");
        await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); window.switchNavTab('agents'); window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); return true; })()`);
        await waitFor(`!!document.querySelector('li.session-group-header[data-group-name] .group-name-text')`, 'the folder group', 10000);
        const g = await ev(`(() => {
            const head = document.querySelector('li.session-group-header[data-group-name]');
            const name = head.querySelector('.group-name-text'), cs = getComputedStyle(name);
            const r = head.getBoundingClientRect(), n = name.getBoundingClientRect();
            return { title: name.title, cut: name.scrollWidth > name.clientWidth, ellipsis: cs.textOverflow, wrap: cs.whiteSpace, inside: n.right <= r.right + 0.5 };
        })()`);
        assert.equal(g.title, LONG, 'the whole name is the title');
        assert.ok(g.cut && g.ellipsis === 'ellipsis' && g.wrap === 'nowrap', 'the name is cut with an ellipsis on one line: ' + JSON.stringify(g));
        assert.ok(g.inside, 'and stays inside its row');
        console.log('PASS UI polish: the skip link, Windows short paths and folder-group names');
    } finally { await Emulation.clearDeviceMetricsOverride().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
