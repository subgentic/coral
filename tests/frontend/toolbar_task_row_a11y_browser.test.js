// The accessibility pass on the shared toolbar and the shared task row (task 7772): every pill group is named and each pill says whether it is chosen (aria-pressed), the compact select is named, a pill that
// is chosen is drawn differently from the others in forced colors too (Windows High Contrast drops the fill that marks it), a More menu opens on Enter with the keyboard on its first item, ArrowDown moves,
// Escape closes it and gives the keyboard back to its button, and on a phone a task is one 44 px button named for the task. Real isolated dev server (helpers/team_page.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-tbr-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev); const Input = client.Input; const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code, vk) => { const text = k === 'Enter' ? '\r' : undefined; await Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
        await openTeam(ev, waitFor, TEAM).catch(() => {});
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(1280, 800, false);
        await S.run('the pill groups are named, each pill has aria-pressed, one is chosen; the compact select has the same name', async () => {
            for (const [tab, name] of [['Goals', 'Show goals that are'], ['Tasks', 'Show tasks that are'], ['Agents', 'Show agents that are']]) {
                await goTab(ev, settle, tab); await settle(500);
                const g = await ev(`(() => { const grp = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) [role=group]')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(name)}); const sel = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) select')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(name)}); return { pressed: grp ? [...grp.querySelectorAll('button')].map(b => b.getAttribute('aria-pressed')) : null, sel: !!sel }; })()`);
                assert.ok(g.pressed && g.pressed.every(v => v === 'true' || v === 'false') && g.pressed.filter(v => v === 'true').length === 1 && g.sel, `${tab}: ` + JSON.stringify(g));
            }
        });
        await S.run('in forced colors the chosen pill and the open tab are drawn differently from the others (Highlight), on Goals, Tasks and Agents', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }); // the Tasks pills stand in as a select below 62 rem of page (#9861): at 1280 there is no pill to draw, so this scenario is at a width that has them
            await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] }); await settle(300);
            for (const tab of ['Goals', 'Tasks', 'Agents']) {
                await goTab(ev, settle, tab); await settle(500);
                const p = await ev(`(() => { const hl = (() => { const t = document.createElement('i'); t.style.color = 'Highlight'; document.body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; })(); const pills = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) .goals-chip, [role=tabpanel]:not([hidden]) .team-chip')].filter(b => b.getClientRects().length && b.hasAttribute('aria-pressed')); const s = b => { const c = getComputedStyle(b); return [c.borderTopColor, c.color, c.fontWeight]; };
                    const on = pills.find(b => b.getAttribute('aria-pressed') === 'true'), off = pills.find(b => b.getAttribute('aria-pressed') === 'false'); return { hl, on: s(on), off: s(off) }; })()`);
                await shot(`forced-pills-${tab}`);
                assert.deepEqual([p.on[0], p.on[1]], [p.hl, p.hl], `${tab}: the chosen pill is Highlight: ` + JSON.stringify(p)); assert.notEqual(p.off[0], p.hl, `${tab}: the others are not: ` + JSON.stringify(p));
                const tabs = await ev(`(() => { const t = [...document.querySelectorAll('.team-tab')].filter(b => b.getClientRects().length); const hl = (() => { const i = document.createElement('i'); i.style.color = 'Highlight'; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; })(); return { hl, on: t.filter(b => b.getAttribute('aria-selected') === 'true').map(b => getComputedStyle(b).borderBottomColor), off: t.filter(b => b.getAttribute('aria-selected') !== 'true').map(b => getComputedStyle(b).borderBottomColor) }; })()`);
                assert.deepEqual(tabs.on, [tabs.hl], `${tab}: the open tab's underline is Highlight: ` + JSON.stringify(tabs)); assert.ok(tabs.off.every(c => c !== tabs.hl), 'and no other tab: ' + JSON.stringify(tabs));
            }
            await goTab(ev, settle, 'Tasks'); await settle(500);
            const dot = await ev(`(() => { const d = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) .goal-chip .goal-dot')].find(e => e.getClientRects().length); const i = document.createElement('i'); i.style.background = 'ButtonText'; document.body.append(i); const bt = getComputedStyle(i).backgroundColor; i.remove(); return { dot: d && getComputedStyle(d).backgroundColor, bt, w: d && Math.round(d.getBoundingClientRect().width) }; })()`);
            assert.ok(dot.dot && dot.w > 0 && dot.dot === dot.bt, 'the state chip dot is filled in ButtonText, not empty space: ' + JSON.stringify(dot));
            await Emulation.setEmulatedMedia({ features: [] }); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        });
        await S.run('a More menu opens on Enter (the keyboard on its first item), ArrowDown moves, Escape closes it and returns to the button', async () => {
            await goTab(ev, settle, 'Board'); await settle(600);
            await ev(`[...document.querySelectorAll('[role=tabpanel]:not([hidden]) button')].find(b => /More board actions/.test(b.getAttribute('aria-label') || '')).focus(); true`);
            await key('Enter', 'Enter', 13); await settle(300);
            const open1 = await ev(`(() => { const a = document.activeElement; return { role: a.getAttribute('role'), name: (a.textContent || '').trim(), expanded: [...document.querySelectorAll('button[aria-haspopup=menu]')].find(b => /More board actions/.test(b.getAttribute('aria-label') || '')).getAttribute('aria-expanded') }; })()`);
            assert.deepEqual(open1, { role: 'menuitem', name: 'Expand all', expanded: 'true' }, JSON.stringify(open1));
            await key('ArrowDown', 'ArrowDown', 40); await settle(150); assert.equal(await ev(`document.activeElement.textContent.trim()`), 'Collapse all');
            await key('Escape', 'Escape', 27); await settle(300);
            assert.deepEqual(await ev(`({ name: document.activeElement.getAttribute('aria-label'), open: [...document.querySelectorAll('[role=menu]')].some(e => e.getClientRects().length) })`), { name: 'More board actions', open: false });
        });
        await open(390, 844, true);
        await S.run('390 px: a task in the Tasks tab is a 44 px row with one button named for the task, in the folded table', async () => {
            await goTab(ev, settle, 'Tasks'); await settle(800);
            const rows = await ev(`[...document.querySelectorAll('[role=tabpanel]:not([hidden]) .dt-table tbody tr')].map(r => { const b = r.querySelector('.dt-primary'); const q = r.getBoundingClientRect(); return { n: r.querySelectorAll('.dt-primary').length, name: b.getAttribute('aria-label'), h: Math.round(q.height), w: Math.round(q.width) }; })`); // the row is the touch target (a tap on it opens the task), the title button the keyboard's
            assert.ok(rows.length >= 3, 'the table has rows: ' + JSON.stringify(rows));
            for (const r of rows) assert.ok(r.n === 1 && r.h >= 44 && /^Open task #\d+: .+/.test(r.name), JSON.stringify(r));
            await shot('tasks-phone');
        });
    } finally { await Emulation.setEmulatedMedia({ features: [] }).catch(() => {}); await removeBoards(ev, [TEAM]); await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
