// The team page at 200% text and on a phone (#7555, QA Reviewer 2's shots): every tab is on screen (the strip wraps, nothing is cut off), the Knowledge tab's count shows without visiting it, Settings rows stack and keep their words whole,
// the Knowledge table keeps its words whole, the details pane is a sheet (the sidebar is not squeezed to a rail of overlapping letters), and the "Discard your changes?" bar puts the question on its own line with Keep editing
// (plain, focused first) and Discard (the danger style) under it. 200% text is the root font doubled, as the text200 suites do it. Isolated dev server; the knowledge notes are stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false, 16], ['1280x800 at 200% text', 1280, 800, false, 32], ['390x844', 390, 844, true, 16], ['390x844 at 200% text', 390, 844, true, 32]];
const TEAM = `qa-layout-${Date.now() % 100000}`;
// words wider than the room they are in: a word the line broke in the middle (canvas-measured with the element's own font)
const BROKEN = (sel) => `(() => { const c = document.createElement('canvas').getContext('2d'); const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    return [...document.querySelectorAll(${JSON.stringify(sel)})].filter(vis).filter(e => { const cs = getComputedStyle(e); c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; const room = e.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return cs.whiteSpace !== 'nowrap' && (e.textContent || '').split(/\\s+/).some(w => w && c.measureText(w).width > room + 1); }).map(e => (e.className || e.tagName) + ': ' + e.textContent.trim().slice(0, 40) + ' (' + Math.round(e.getBoundingClientRect().width) + ' px wide, ' + cs0(e) + ')'); })()`.replace('cs0(e)', "getComputedStyle(e).fontSize");

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); const j = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (String((o && o.method) || 'GET').toUpperCase() === 'GET' && /\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname)) return j({ exists: true, team_name: ${JSON.stringify(TEAM)}, created_at: '2026-10-25T05:00:00Z', index: '# Index\\nWhat the team knows.', agents: [{ name: 'Orchestrator', content: 'Orchestrator knowledge text.' }, { name: 'Backend Dev', content: 'Backend knowledge text.' }] });
            return R(u, o); }; return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, font] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM); await stub();
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await ev(`document.documentElement.style.fontSize = '${font}px'; true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {}); await settle(1500);
            await S.run(`${label}: every tab is reachable in the strip: the selected tab is in view on load and after each press, a fade says there is more, and the page does not scroll sideways`, async () => {
                const inView = (name) => ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === ${JSON.stringify(name)}) || document.getElementById('team-tab-more'); const b = t.getBoundingClientRect(), s = t.id === 'team-tab-more' ? { left: 0, right: innerWidth } : window.__tp.tablist().getBoundingClientRect(); /* a phone's tab behind More: More is the one in view, beside the strip */ return b.left >= s.left - 1 && b.right <= s.right + 1 && b.left >= -1 && b.right <= innerWidth + 1; })()`);
                const r = await ev(`(() => { const t = window.__tp.tablist(); return { over: t.scrollWidth - t.clientWidth, more: t.dataset.more || '', n: window.__tp.allTabs().length, shown: window.__tp.tabs().length, page: document.documentElement.scrollWidth - innerWidth, h: Math.round(t.getBoundingClientRect().height) }; })()`);
                assert.equal(r.n, 7, 'seven tabs'); assert.equal(r.shown, mobile ? 4 : 7, mobile ? 'four tabs in the row, the rest behind More' : 'every tab in the row'); assert.ok(r.page <= 1, `the page does not scroll sideways (${r.page})`);
                if (r.over > 1) assert.ok(r.more, 'the strip scrolls, and a fade at its edge says there is more');
                assert.equal(await inView('Goals'), true, 'the selected tab (Goals) is in view on load');
                for (const name of ['Artifacts', 'Knowledge', 'Settings', 'Tasks']) {
                    await goTab(ev, settle, name); await settle(300);
                    assert.equal(await inView(name), true, `${name} is in view after it is pressed`);
                    assert.equal(await ev(`window.__tp.allTabs().find(x => window.__tp.tabLabel(x) === ${JSON.stringify(name)}).getAttribute('aria-selected')`), 'true');
                }
                assert.equal(await ev(`Math.round(window.__tp.tablist().getBoundingClientRect().height)`), r.h, 'the strip keeps its height from tab to tab');
            });
            await S.run(`${label}: the Knowledge tab shows its count without being visited`, async () => {
                await goTab(ev, settle, 'Goals'); await settle(300);
                await waitFor(`(() => { const t = window.__tp.allTabs().find(x => window.__tp.tabLabel(x) === 'Knowledge'); return !!t && /Knowledge\\s*3/.test(window.__na.name(t)); })()`, 'Knowledge 3 on the tab', 8000);
            });
            await S.run(`${label}: Settings: no word is broken, the rows stack (the control under its label) and Working mode is reachable`, async () => {
                await goTab(ev, settle, 'Settings'); await settle(900);
                const broken = await ev(BROKEN('.sv-label, .sv-help, .settings-pane-title, .settings-pane-sub, .sv-lead')); assert.deepEqual(broken, [], 'no word of the labels and hints is broken: ' + JSON.stringify(broken));
                const r = await ev(`(() => { const sel = window.__tp.find('select', /^Working mode$/i); const row = sel.closest('.sv-row'); const text = row.querySelector('.sv-text').getBoundingClientRect(), ctl = row.querySelector('.sv-control').getBoundingClientRect(); const sc = document.querySelector('.team-settings-page .settings-panes').getBoundingClientRect(); sel.scrollIntoView({ block: 'nearest' }); const b = sel.getBoundingClientRect(); return { stacked: ctl.top >= text.bottom - 1, within: b.left >= sc.left - 1 && b.right <= sc.right + 1 }; })()`);
                assert.equal(r.within, true, 'the Working mode select is inside the page'); if (font > 16 || mobile) assert.equal(r.stacked, true, 'the control is under the label and hint');
            });
            await S.run(`${label}: Knowledge: no word of the table or its count line is broken`, async () => {
                await goTab(ev, settle, 'Knowledge'); await settle(900);
                const broken = await ev(BROKEN('#team-panel-knowledge td, #team-panel-knowledge th, #team-panel-knowledge .team-count-line, #team-panel-knowledge .dt-primary')); assert.deepEqual(broken, [], 'no word is broken: ' + JSON.stringify(broken));
                const sc = await ev(`(() => { const page = document.querySelector('#team-panel-knowledge .goals-table-page'), box = document.querySelector('#team-panel-knowledge .dt-box'); const cs = getComputedStyle(page); return { pageScrolls: /auto|scroll/.test(cs.overflowX) || page.scrollWidth > page.clientWidth + 1, box: !!box && box.scrollWidth <= box.clientWidth + 1 }; })()`);
                assert.equal(sc.pageScrolls, false, 'the tab page is not the scroller: the count line and Distill knowledge stay put'); assert.equal(sc.box, true, 'the shared table fits its box');
            });
            await S.run(`${label}: the pane is a sheet over the page: the sidebar keeps its width or is out of the way, no rail of letters`, async () => {
                await ev(`(() => { const b = [...window.__tp.table().querySelectorAll('button')].find(x => /Backend Dev/.test(window.__na.name(x))); b.click(); return true; })()`); await settle(600);
                const r = await ev(`(() => { const p = window.__tp.pane(); const b = p.getBoundingClientRect(); const side = document.querySelector('.layout > .sidebar'); const s = side && getComputedStyle(side).display !== 'none' ? side.getBoundingClientRect().width : 0; return { pane: { w: Math.round(b.width), left: Math.round(b.left) }, sidebar: Math.round(s), collapsed: !!document.querySelector('.layout.sidebar-collapsed'), vw: innerWidth }; })()`);
                if (font > 16 || mobile) assert.equal(r.collapsed, false, `the sidebar is not squeezed to a rail (${JSON.stringify(r)})`); // at 100% on a desktop the pane sits beside a 56 px rail, by design
                const under = await ev(`(() => { const p = window.__tp.pane().getBoundingClientRect(), t = document.querySelector('#team-panel-knowledge .dt-box').getBoundingClientRect(); return t.right > p.left + 1 && p.left > 1 && p.width < innerWidth - 2; })()`);
                assert.equal(under, false, 'the table does not run under the pane');
                if (font > 16 || mobile) assert.ok(r.pane.w >= r.vw - 2 && r.pane.left <= 1, `the pane is a sheet over the whole window (${JSON.stringify(r)})`);
            });
            await S.run(`${label}: the Discard bar: the question on its own line, Keep editing plain and focused, Discard in the danger style`, async () => {
                const pane = `window.__tp.pane()`;
                const btnIn = (rx) => `(() => { const p = ${pane}; return p ? [...p.querySelectorAll('button')].filter(window.__na.vis).find(b => ${rx}.test(window.__na.name(b))) : null; })()`;
                await ev(`${btnIn('/^Edit$/')}.click(); true`); await settle(300);
                await ev(`(() => { const t = ${pane}.querySelector('textarea'); t.value = 'Changed notes.'; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`); await settle(300);
                const r = await ev(`(() => { const f = ${pane}.querySelector('.detail-foot'); const q = f.querySelector('.detail-status'); const keep = ${btnIn('/^Keep editing$/')}, drop = ${btnIn('/^Discard$/')}; const fb = f.getBoundingClientRect(), qb = q.getBoundingClientRect(); const lines = Math.round(qb.height / parseFloat(getComputedStyle(q).lineHeight === 'normal' ? parseFloat(getComputedStyle(q).fontSize) * 1.3 : getComputedStyle(q).lineHeight));
                    return { text: q.textContent, lines, ownLine: qb.width >= fb.width * 0.8, below: Math.min(keep.getBoundingClientRect().top, drop.getBoundingClientRect().top) >= qb.bottom - 1, focusKeep: document.activeElement === keep, danger: drop.classList.contains('btn-danger'), keepPrimary: keep.classList.contains('btn-primary'), dropPrimary: drop.classList.contains('btn-primary') }; })()`);
                assert.equal(r.text, 'Discard your changes?'); assert.ok(r.ownLine, `the question has the bar's width (${JSON.stringify(r)})`); assert.ok(r.lines <= 2, `the question is one or two lines (${r.lines})`); assert.ok(r.below, 'the buttons are under it');
                assert.equal(r.focusKeep, true, 'Keep editing has the focus'); assert.equal(r.keepPrimary || r.dropPrimary, false, 'neither is the blue primary'); assert.equal(r.danger, true, 'Discard is the danger button (error text with an error edge)');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
