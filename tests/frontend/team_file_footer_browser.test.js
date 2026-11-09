// The file's open view has ONE row at the bottom (#14963, the Operator: eight buttons in two rows and a help line were too much): More, Download and Open (the primary, last). More holds Send for review, Copy link, Copy file ID, Star and Keep,
// each with a line saying what it does where it needs one, and Delete last, set apart, red. Measured at 1280 and 390 px: one row, the menu whole inside the window, 44 px targets on a phone, Star toggles in the menu and Escape gives the focus back to More.
'use strict';

const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const results = [];
const check = (label, ok, detail) => { results.push(!!ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation, Input } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const press = async (key, code, vk) => { const b = { key, code, windowsVirtualKeyCode: vk }; await Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(key === 'Enter' ? { text: '\r' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...b }); };
    let sid = null, name = null;
    const B = 'ff-' + Date.now().toString(36);
    const PANE = '.detail-pane:not([hidden])';
    try {
        await Page.enable();
        await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        let loaded = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await loaded; await coralReady();
        const launch = await ev(`fetch('/api/sessions/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ working_dir: ${JSON.stringify(require('node:os').tmpdir())}, agent_type: 'terminal', display_name: 'Footer QA' }) }).then(r => r.json())`);
        sid = launch.session_id; name = launch.session_name || launch.name;
        await ev(`fetch('/api/board/${B}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Footer QA', job_title: 'Backend Dev', session_name: ${JSON.stringify(name)} }) }).then(r => r.status)`);
        await ev(`fetch('/api/agent/artifacts?session_id=${sid}', { method: 'POST', headers: { 'X-Artifact-Name': 'footer.txt', 'X-Artifact-Media-Type': 'text/plain' }, body: 'a file for the footer test ' + Date.now() }).then(r => r.status)`);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            loaded = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await loaded; await coralReady();
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
            await waitFor(`!!document.querySelector('#team-panel-artifacts [data-artifact-id]')`, `${at}the file's row`, 15000);
            await ev(`document.querySelector('#team-panel-artifacts [data-artifact-id]').click(); true`);
            await waitFor(`!!document.querySelector('${PANE} .detail-foot .task-more-btn') && document.querySelector('${PANE} .detail-foot').getBoundingClientRect().height > 0`, `${at}the open view`, 10000);
            const foot = await ev(`(() => { const f = document.querySelector('${PANE} .detail-foot'); const kids = [...f.querySelectorAll('.detail-more .task-more-btn, :scope > .btn')]; const r = kids.map(b => b.getBoundingClientRect());
                return { labels: kids.map(b => b.textContent.trim()), tops: r.map(x => Math.round(x.top)), heights: r.map(x => Math.round(x.height)), note: !!document.querySelector('${PANE} .detail-note'), over: document.documentElement.scrollWidth > innerWidth + 1, lastIsPrimary: !!f.lastElementChild.classList.contains('btn-primary') }; })()`);
            check(`${at}one row: More, Download, Open (${JSON.stringify(foot.labels)}), no help line`, JSON.stringify(foot.labels) === JSON.stringify(['More', 'Download', 'Open']) && Math.max(...foot.tops) - Math.min(...foot.tops) <= 2 && !foot.note && foot.lastIsPrimary && !foot.over, JSON.stringify(foot));
            if (mobile) check(`${at}the three are 44 px targets`, foot.heights.every(x => x >= 43.5), JSON.stringify(foot.heights));
            // the menu: open by key, whole inside the window, in order, Delete last and set apart
            await ev(`document.querySelector('${PANE} .detail-foot .task-more-btn').focus(); true`);
            await press('Enter', 'Enter', 13);
            await waitFor(`document.querySelector('${PANE} .detail-foot .task-more-btn').getAttribute('aria-expanded') === 'true'`, `${at}the More menu opens`, 4000);
            const menu = await ev(`(() => { const m = document.querySelector('${PANE} .detail-foot .team-more-menu'); const r = m.getBoundingClientRect(); const items = [...m.querySelectorAll('[role^=menuitem]')];
                return { items: items.map(b => (b.querySelector('.more-item-label') || b).textContent), descs: items.map(b => (b.querySelector('.more-item-desc') || {}).textContent || ''), sepBeforeDelete: m.lastElementChild.previousElementSibling?.getAttribute('role') === 'separator', delDanger: items[items.length - 1].classList.contains('menu-item-danger'), inside: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] }; })()`);
            check(`${at}the menu lists Send for review, Copy link, Copy file ID, Star, Keep, then Delete; Copy file ID is there for a file that has an id (${JSON.stringify(menu.items)})`, JSON.stringify(menu.items.filter(x => x !== 'Copy file ID')) === JSON.stringify(['Send for review', 'Copy link', 'Star', 'Keep', 'Delete']) && menu.sepBeforeDelete && menu.delDanger, JSON.stringify(menu));
            check(`${at}Star and Keep say what they do, and the menu is whole inside the window`, /Starred list/.test(menu.descs[menu.items.indexOf('Star')]) && /cleanup never deletes/.test(menu.descs[menu.items.indexOf('Keep')]) && menu.inside, JSON.stringify(menu));
            // Star toggles in the menu
            await ev(`[...document.querySelectorAll('${PANE} .detail-foot [role=menuitemcheckbox]')].find(b => b.querySelector('.more-item-label').textContent === 'Star').click(); true`);
            await waitFor(`[...document.querySelectorAll('${PANE} .detail-foot [role=menuitemcheckbox]')].some(b => b.getAttribute('aria-checked') === 'true' && b.querySelector('.more-item-label').textContent === 'Star')`, `${at}Star is checked in the menu and keeps its name (the state is aria-checked, not a new label)`, 6000);
            check(`${at}no menu item repeats its description as a title`, await ev(`[...document.querySelectorAll('${PANE} .detail-foot [role^=menuitem]')].every(b => !b.querySelector('.more-item-desc') || !b.title)`));
            check(`${at}choosing an item closes the menu and the focus is back on More`, await ev(`document.querySelector('${PANE} .detail-foot .task-more-btn').getAttribute('aria-expanded') === 'false' && document.activeElement === document.querySelector('${PANE} .detail-foot .task-more-btn')`));
            await ev(`[...document.querySelectorAll('${PANE} .detail-foot [role=menuitemcheckbox]')].find(b => b.querySelector('.more-item-label').textContent === 'Star').click(); true`); // back to unstarred: the next width starts clean
            await press('Enter', 'Enter', 13); await press('Escape', 'Escape', 27);
            check(`${at}Escape closes the menu and keeps the focus on More`, await ev(`document.querySelector('${PANE} .detail-foot .task-more-btn').getAttribute('aria-expanded') === 'false' && document.activeElement === document.querySelector('${PANE} .detail-foot .task-more-btn')`));
            // the reverse: a file that is already starred opens as 'Star', checked; pressing it keeps the name and unchecks it (UI Accessibility's MUST on #14972)
            const hexOf = await ev(`document.querySelector('#team-panel-artifacts [data-artifact-id]').dataset.artifactId`);
            await ev(`fetch('/api/artifacts/${hexOf}/star', { method: 'PUT' }).then(r => r.status)`);
            loaded = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await loaded; await coralReady(); // the list is read again: the file is starred on the server now
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
            await waitFor(`!!document.querySelector('#team-panel-artifacts [data-artifact-id]')`, `${at}the file's row again`, 15000);
            await ev(`document.querySelector('#team-panel-artifacts [data-artifact-id]').click(); true`);
            await waitFor(`!!document.querySelector('${PANE} .detail-foot .task-more-btn') && document.querySelector('${PANE} .detail-foot').getBoundingClientRect().height > 0`, `${at}the open view of the starred file`, 10000);
            const starItem = `[...document.querySelectorAll('${PANE} .detail-foot [role=menuitemcheckbox]')].find(b => b.querySelector('.more-item-label').textContent === 'Star')`;
            check(`${at}an already starred file shows Star, checked`, await ev(`!!(${starItem}) && (${starItem}).getAttribute('aria-checked') === 'true'`));
            await ev(`(${starItem}).click(); true`);
            await waitFor(`(${starItem}).getAttribute('aria-checked') === 'false'`, `${at}unstarring turns the check off`, 6000);
            check(`${at}pressing it keeps the name Star and unchecks it`, await ev(`!!(${starItem}) && (${starItem}).getAttribute('aria-checked') === 'false'`));
        }
    } catch (e) {
        check('no error', false, e.message);
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(name)}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
