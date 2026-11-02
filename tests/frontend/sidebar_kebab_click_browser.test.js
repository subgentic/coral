// The first click on an agent row's menu item always works (#10786, Beta #10775: "More actions for Alpha" was open, Rename was clicked and nothing happened; the second click worked): real mouse events on the item at 0 and 100 ms after
// the menu opens, and after the live list redraws its rows while the menu is open (the poll does that every few seconds): the Rename dialog opens each time. 1280 px; the page's mocked agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        for (const variant of ['at once', 'after 100 ms', 'after a redraw', 'after a redraw with new data', 'after another agent appears', 'after a status change']) {
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const setList = n => ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`.replace("'Writer'", `'Writer${n}'`));
            await setList('');
            await waitFor(`!!document.querySelector('.session-group-item .sidebar-kebab-btn')`, 'the agent row', 10000);
            const centre = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
            const click = async p => { await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); };
            await click(await centre('.session-group-item .sidebar-kebab-btn'));
            await waitFor(`[...document.querySelectorAll('.sidebar-kebab-menu')].some(m => getComputedStyle(m).display !== 'none')`, `${variant}: the menu opens`, 4000);
            if (variant === 'after 100 ms') await ev(framesJs(6));
            if (variant === 'after another agent appears') { await ev(`window.__m.add('proj2', 'A', 2, { sleeping: false, session_id: 'x-sid', display_name: 'Other', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`); await ev(framesJs(4)); }
            if (variant === 'after a status change') { await ev(`window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), status: { ...(window.__m.entry(a).status || {}), summary: 'busy now', status: 'working' } }))); true`); await ev(framesJs(4)); }
            if (variant.startsWith('after a redraw')) { await setList(variant.endsWith('data') ? '2' : ''); await ev(framesJs(4)); }
            const item = await ev(`(() => { const m = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); const it = m && [...m.querySelectorAll('.overflow-menu-item, .menu-item')].find(e => /^Rename/.test(e.textContent.trim())); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
            assert.ok(item, `${variant}: the menu is still open with Rename in it`);
            await click(item);
            await ev(framesJs(4));
            const dlg = await ev(`(() => { const d = [...document.querySelectorAll('dialog[open], .modal')].find(x => x.getClientRects().length && /Rename/i.test(x.textContent)); return !!d; })()`);
            assert.ok(dlg, `${variant}: the first click on Rename opens the Rename dialog`);
        }
    } finally { await client.close(); }
    console.log('sidebar_kebab_click_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
