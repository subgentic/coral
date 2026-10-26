// The team page's tabs on a phone (Goal #60, audit #8572 point 5): seven tabs scrolled sideways at 390 px. Now Goals, Board, Tasks and Agents are the row and Artifacts, Knowledge and Settings are behind
// a More menu (desktop unchanged: all seven, no More). The row never scrolls sideways; More is a 44 px menu button that says which of its tabs is open; the menu is reachable by keyboard (Enter or ArrowDown
// opens it on its first item, arrows move, Escape closes it back on More, Enter chooses) and by a screen reader (a menu button with aria-haspopup and aria-expanded, a menu of menuitems named for the tabs).
// Written failing-first against a build with seven tabs at 390. Isolated dev server, 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const fs = require('node:fs');

const TEAM = `qa-tabs-more-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const { Input } = client;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, ...(k === 'Enter' ? { text: '\r' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); };
    const state = () => ev(`(() => { const tl = document.getElementById('team-tabs'), more = document.getElementById('team-tab-more'), menu = document.getElementById('team-tabs-more-menu');
        const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const tabs = [...tl.querySelectorAll('[role=tab]')].filter(vis).map(t => t.dataset.tab);
        const sel = [...tl.querySelectorAll('[role=tab]')].find(t => t.getAttribute('aria-selected') === 'true');
        const r = more ? more.getBoundingClientRect() : null;
        return { tabs, selected: sel && sel.dataset.tab, shown: vis(more), name: more && more.getAttribute('aria-label'), text: more && more.textContent.trim(), expanded: more && more.getAttribute('aria-expanded'), haspopup: more && more.getAttribute('aria-haspopup'),
            h: r && Math.round(r.height), w: r && Math.round(r.width), sideways: tl.scrollWidth - tl.clientWidth, current: more && more.classList.contains('is-current'), inList: !!(more && tl.contains(more)),
            menuOpen: !!menu && !menu.hidden && vis(menu), items: menu ? [...menu.querySelectorAll('[role=menuitem]')].map(i => ({ tab: i.dataset.tab, name: i.textContent.replace(/\\s+/g, ' ').trim(), h: Math.round(i.getBoundingClientRect().height) })) : [],
            focus: document.activeElement && (document.activeElement.id || document.activeElement.dataset.tab || document.activeElement.tagName), panel: ['artifacts', 'knowledge', 'settings', 'goals'].find(p => vis(document.getElementById('team-panel-' + p))) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM); await settle(500);
            let s = await state();
            if (!mobile) {
                check('1280: all seven tabs are in the row and there is no More', s.tabs.join() === 'goals,messages,tasks,agents,artifacts,knowledge,settings' && !s.shown, JSON.stringify(s.tabs));
                check('1280: the row does not scroll sideways', s.sideways <= 0, String(s.sideways));
                await shot('team-tabs-1280');
                continue;
            }
            check('390: the row is Goals, Board, Tasks and Agents, then More', s.tabs.join() === 'goals,messages,tasks,agents' && s.shown, JSON.stringify(s.tabs));
            check('390: the row never scrolls sideways', s.sideways <= 0, String(s.sideways));
            check('390: More is a menu button (aria-haspopup=menu, aria-expanded=false) named "More tabs", 44 px, beside the tab list and not a tab in it', s.haspopup === 'menu' && s.expanded === 'false' && s.name === 'More tabs' && s.h >= 44 && s.w >= 44 && !s.inList, JSON.stringify(s));
            await shot('team-tabs-390');
            // by keyboard: Enter opens on the first item, the arrows move, Escape closes back on More
            await ev(`document.getElementById('team-tab-more').focus(); true`);
            await key('Enter', 13); await settle(250);
            s = await state();
            check('390: Enter on More opens the menu with Artifacts, Knowledge and Settings (menuitems, 44 px), the first focused, aria-expanded true', s.menuOpen && s.expanded === 'true' && s.items.map(i => i.tab).join() === 'artifacts,knowledge,settings' && s.items.every(i => i.h >= 44 && /^(Artifacts|Knowledge|Settings)/.test(i.name)) && s.focus === 'artifacts' || (s.menuOpen && s.focus && /artifacts/.test(String(s.focus))), JSON.stringify(s));
            await shot('team-tabs-390-menu');
            await key('ArrowDown', 40); await settle(100);
            check('390: ArrowDown moves to the next item', (await state()).focus === 'knowledge', (await state()).focus);
            await key('Escape', 27); await settle(200);
            s = await state();
            check('390: Escape closes the menu and the keyboard is back on More', !s.menuOpen && s.expanded === 'false' && s.focus === 'team-tab-more', JSON.stringify(s));
            // choose by keyboard
            await key('Enter', 13); await settle(200); await key('ArrowDown', 40); await key('ArrowDown', 40); await key('Enter', 13); await settle(600);
            s = await state();
            check('390: choosing Settings from the menu opens the Settings tab, More says so (named "Settings, more tabs", underlined, its words still More so the strip keeps its width) and keeps the keyboard', s.selected === 'settings' && s.panel === 'settings' && s.name === 'Settings, more tabs' && s.current && s.text === 'More' && s.focus === 'team-tab-more' && !s.menuOpen, JSON.stringify(s));
            await shot('team-tabs-390-settings');
            // by tap
            await ev(`document.getElementById('team-tab-more').click(); true`); await settle(200);
            await ev(`document.querySelector('#team-tabs-more-menu [data-tab="artifacts"]').click(); true`); await settle(600);
            s = await state();
            check('390: tapping Artifacts opens the Artifacts tab', s.selected === 'artifacts' && s.panel === 'artifacts' && s.current, JSON.stringify(s));
            // a tab of the row takes the page back and More is a plain More again
            await ev(`document.getElementById('team-tab-goals').click(); true`); await settle(500);
            s = await state();
            check('390: a tab of the row opens its page and More is plain again', s.selected === 'goals' && !s.current && s.name === 'More tabs' && s.text === 'More', JSON.stringify(s));
            // the arrow keys of the row stay on the tabs that are in it
            await ev(`document.getElementById('team-tab-agents').focus(); true`);
            await key('ArrowRight', 39); await settle(300);
            s = await state();
            check('390: ArrowRight from Agents wraps to Goals, not to a tab behind More', s.focus === 'team-tab-goals' && s.selected === 'goals', JSON.stringify(s));
            check('390: the page does not scroll sideways', (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await removeBoards(ev, [TEAM]).catch(() => {});
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})().catch(e => { console.error(e); process.exitCode = 1; });
