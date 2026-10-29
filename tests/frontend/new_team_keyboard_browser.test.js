// New team and Edit member by keyboard and screen reader (#7407; UI/UX's final v4 doc ad146b3a, section 4), written failing-first by QA (#7415): both dialogs are modal and named, Enter in the name or folder is Next
// (and does nothing while one is missing), each step is said once in a polite status, step 3's tabs and Edit member's tabs are real tabs (one tab stop, arrows, Home and End), a member row is one button named Edit <role> (#10836: no actions menu),
// provider and model, the actions button has aria-haspopup and aria-expanded and its menu is a menu (arrows move, Escape closes and the focus goes back to the button), Escape in Edit member closes it and returns the
// focus to the row that opened it, Tab stays inside the top dialog, Mode is a radiogroup with arrow keys, every control of every step and tab has an accessible name. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, M, N, T, openNewTeam, scenarios, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const { Input } = client;
    const S = scenarios(); const t = T(ev, waitFor);
    const KEYS = { Enter: [13, '\r'], Escape: [27], Tab: [9], ArrowRight: [39], ArrowLeft: [37], ArrowDown: [40], ArrowUp: [38], Home: [36], End: [35], ' ': [32, ' '] };
    const key = async (k, mods = 0) => { const [vk, text] = KEYS[k]; for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: vk, modifiers: mods, ...(type === 'keyDown' && text ? { text } : {}) }); await settle(120); };
    const insideTop = () => ev(`(() => { const a = document.activeElement; const m = window.__nt.dlg(${N.member}); const d = m || window.__nt.dlg(${N.team}); return { inside: !!(d && a && d.contains(a)), name: a ? (window.__na.name(a) || a.tagName) : '' }; })()`);
    const unnamed = within => ev(`(() => { const d = window.__nt.dlg(${within}); return [...d.querySelectorAll('button, input, select, textarea, [role=radio], [role=tab], [role=menuitem], summary')].filter(window.__na.vis).filter(e => e.type !== 'hidden' && !window.__na.name(e)).map(e => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')); })()`);
    const focusRow = role => ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team})).find(x => window.__na.name(x) === 'Edit ' + ${JSON.stringify(role)}); b.focus(); return document.activeElement === b; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor);

        await S.run('New team is modal and named: role=dialog, aria-modal=true, name "New team", and the keyboard starts inside it', async () => {
            const d = await ev(`(() => { const d = window.__nt.dlg(${N.team}); return d ? { modal: d.getAttribute('aria-modal'), name: window.__na.name(d) } : null; })()`);
            assert.ok(d, 'role=dialog named New team'); assert.equal(d.modal, 'true'); assert.ok((await insideTop()).inside, 'focus starts inside the dialog');
        });
        await S.run('Enter in the folder is Next when the team name and folder are there, and does nothing while one is missing', async () => {
            await t.type('input', N.teamName, ''); await t.type('input', N.folder, '/work/payments-app');
            await ev(`window.__nt.find(window.__nt.dlg(${N.team}), 'input', ${N.folder}).focus(); true`); await key('Enter');
            assert.match(await ev(`window.__na.text(window.__nt.dlg(${N.team}))`), /Step 1 of 3/, 'no name: still step 1');
            await t.type('input', N.teamName, 'alpha'); await ev(`window.__nt.find(window.__nt.dlg(${N.team}), 'input', ${N.folder}).focus(); true`); await key('Enter');
            await t.step(2); assert.ok((await insideTop()).inside, 'focus stays inside the dialog after Next');
        });
        await S.run('each step is said in a polite status ("Step 2 of 3: ...", "Step 3 of 3: ...")', async () => {
            const say = () => ev(`[...window.__nt.dlg(${N.team}).querySelectorAll('[aria-live=polite],[role=status]')].map(e => window.__na.text(e)).join(' | ')`);
            assert.match(await say(), /Step 2 of 3/);
            await t.pick(N.template, /Coding|\(\d+ members\)/); await settle(400); await t.click('button', N.next); await t.step(3); await settle(200); assert.match(await say(), /Step 3 of 3/);
        });
        await S.run('step 3 tabs are real tabs: a tablist, one selected, one tab stop, each tab controls a tabpanel named by it', async () => {
            const tabs = await ev(`(() => { const tl = window.__nt.tablist(window.__nt.dlg(${N.team})); if (!tl) return null; return { o: tl.getAttribute('aria-orientation'), t: [...tl.querySelectorAll('[role=tab]')].map(x => ({ n: window.__na.name(x), s: x.getAttribute('aria-selected'), tab: x.tabIndex, c: (() => { const p = document.getElementById(x.getAttribute('aria-controls') || ''); return p ? { role: p.getAttribute('role'), by: p.getAttribute('aria-labelledby') === x.id } : null; })() })) }; })()`);
            assert.ok(tabs, 'a role=tablist'); assert.equal(tabs.t.length, 4); assert.equal(tabs.t.filter(x => x.s === 'true').length, 1);
            assert.deepEqual(tabs.t.map(x => x.tab).sort(), [-1, -1, -1, 0], 'one tab stop');
            for (const x of tabs.t) { assert.ok(x.c, `${x.n}: aria-controls points to a panel`); assert.equal(x.c.role, 'tabpanel'); assert.ok(x.c.by, `${x.n}: the panel is labelled by its tab`); }
        });
        await S.run('tablist keys on step 3: arrows along the axis move and select (wrapping), Home and End go to the ends', async () => {
            const vertical = await ev(`window.__nt.tablist(window.__nt.dlg(${N.team})).getAttribute('aria-orientation') === 'vertical'`);
            const [next, prev] = vertical ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
            const cur = () => ev(`(() => { const x = [...window.__nt.dlg(${N.team}).querySelectorAll('[role=tab]')].find(e => e.getAttribute('aria-selected') === 'true'); return { n: window.__na.name(x), f: document.activeElement === x }; })()`);
            await ev(`[...window.__nt.dlg(${N.team}).querySelectorAll('[role=tab]')].find(e => e.getAttribute('aria-selected') === 'true').focus(); true`);
            assert.equal((await cur()).n, 'Start'); await key(next); assert.deepEqual(await cur(), { n: 'Workflow', f: true });
            await key(next); await key(next); assert.equal((await cur()).n, 'Messaging'); await key(next); assert.equal((await cur()).n, 'Start', 'wraps to the first');
            await key(prev); assert.equal((await cur()).n, 'Messaging', 'wraps to the last'); await key('Home'); assert.equal((await cur()).n, 'Start'); await key('End'); assert.equal((await cur()).n, 'Messaging'); await key('Home');
        });
        await S.run('no control of any tab of step 3, and none of step 2, is without an accessible name', async () => {
            for (const n of N.tabs) { await ev(`[...window.__nt.dlg(${N.team}).querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === ${JSON.stringify(n)}).click(); true`); await settle(250); assert.deepEqual(await unnamed(N.team), [], `step 3, ${n}: unnamed controls`); }
            await t.click('button', N.back); await t.step(2); assert.deepEqual(await unnamed(N.team), [], 'step 2: unnamed controls');
        });
        await S.run('a member row is one button named "Edit <role>", described by its provider and model, with no menu; Alt+ArrowDown moves it and says so; Escape in Edit member returns the focus to it (#10836)', async () => {
            const role = (await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`))[1];
            const st = () => ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = window.__nt.rows(d).find(x => window.__na.name(x) === 'Edit ' + ${JSON.stringify(role)}); const r = b.closest('.team-agent-row'); return b ? { popup: b.getAttribute('aria-haspopup'), desc: (document.getElementById(b.getAttribute('aria-describedby')) || {}).textContent || '', buttons: [...r.querySelectorAll('button')].filter(window.__na.vis).length, menus: [...d.querySelectorAll('[role=menu]')].some(window.__na.vis) } : null; })()`);
            const s = await st(); assert.ok(s, 'an Edit <role> button'); assert.equal(s.popup, null, 'no menu on it'); assert.equal(s.buttons, 1, 'the row has one button'); assert.ok(!s.menus, 'no role=menu'); assert.match(s.desc, /.+ · .+/, 'described by its provider and model: ' + s.desc);
            assert.ok(await focusRow(role), 'the row takes focus');
            await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })); true`); await settle(200);
            assert.equal((await insideTop()).name, 'Edit ' + role, 'the focus stays on the moved row\'s button');
            assert.match(await ev(`document.getElementById('team-agents-live').textContent`), new RegExp('^Moved ' + role + ' to \\d+ of \\d+$'), 'said politely');
        });
        await S.run('Enter on a member row opens Edit member (modal, named); Escape closes it and the focus returns to that row; the dialog behind stays', async () => {
            const role = (await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`))[1];
            assert.ok(await focusRow(role), 'the row takes focus'); await key('Enter');
            await waitFor(`!!window.__nt.dlg(${N.member})`, 'Edit member opens', 4000);
            const m = await ev(`(() => { const d = window.__nt.dlg(${N.member}); return { modal: d.getAttribute('aria-modal'), name: window.__na.name(d) }; })()`); assert.equal(m.modal, 'true'); assert.match(m.name, /^Edit member/);
            assert.ok((await insideTop()).inside, 'focus is inside Edit member');
            await key('Escape'); await waitFor(`!window.__nt.dlg(${N.member})`, 'Escape closes Edit member', 4000); await settle(200);
            assert.ok(await ev(`!!window.__nt.dlg(${N.team})`), 'New team is still open');
            assert.match((await insideTop()).name, new RegExp('^Edit ' + role.replace(/[^\w]/g, '.') + '$'), 'focus is back on the row that opened it');
        });
        await S.run('Edit member: the tabs Agent, Permissions, Advanced of the settings are real tabs with the arrow keys, the persona page before them is named; every control of each tab is named; Mode is a radiogroup with arrow keys; Tab stays inside it', async () => {
            const role = (await ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`))[1];
            await focusRow(role); await key('Enter'); await waitFor(`!!window.__nt.dlg(${N.member})`, 'Edit member', 4000);
            const tl = await ev(`(() => { const tl = window.__nt.tablist(window.__nt.dlg(${N.member})); return tl ? [...tl.querySelectorAll('[role=tab]')].filter(window.__na.vis).map(x => window.__na.name(x)) : null; })()`);
            assert.deepEqual(tl, N.memberTabs, 'a tablist with the three tabs');
            const vertical = await ev(`window.__nt.tablist(window.__nt.dlg(${N.member})).getAttribute('aria-orientation') === 'vertical'`); const next = vertical ? 'ArrowDown' : 'ArrowRight';
            await ev(`[...window.__nt.dlg(${N.member}).querySelectorAll('[role=tab]')].find(x => x.getAttribute('aria-selected') === 'true').focus(); true`); await key(next);
            assert.equal(await ev(`window.__na.name([...window.__nt.dlg(${N.member}).querySelectorAll('[role=tab]')].find(x => x.getAttribute('aria-selected') === 'true'))`), 'Permissions', 'the arrow selects the next tab (Edit member opens on Agent)');
            for (const n of N.memberTabs) { await ev(`[...window.__nt.dlg(${N.member}).querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === ${JSON.stringify(n)}).click(); true`); await settle(250); assert.deepEqual(await unnamed(N.member), [], `Edit member, ${n}: unnamed controls`); }
            await ev(`[...window.__nt.dlg(${N.member}).querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === 'Permissions').click(); true`); await settle(250); // Permissions open: the loop above ended on Advanced
            await M(ev, waitFor).toPersona(); assert.deepEqual(await unnamed(N.member), [], 'Edit member, the persona page: unnamed controls'); await M(ev, waitFor).section('Permissions');
            const mode = () => ev(`(() => { const g = [...window.__nt.dlg(${N.member}).querySelectorAll('[role=radiogroup]')].find(e => /mode$/i.test(window.__na.name(e))); if (!g) return null; const r = window.__na.radios(g); const i = r.findIndex(x => window.__na.isChecked(x)); return { i, n: r.length, f: document.activeElement === r[i] }; })()`);
            await ev(`(() => { const g = [...window.__nt.dlg(${N.member}).querySelectorAll('[role=radiogroup]')].find(e => /mode$/i.test(window.__na.name(e))); window.__na.radios(g).find(x => window.__na.isChecked(x)).focus(); return true; })()`);
            const a = await mode(); assert.ok(a, 'a Mode radiogroup on Permissions'); await key('ArrowRight'); const b = await mode(); assert.equal(b.i, (a.i + 1) % a.n, 'ArrowRight moves the mode'); assert.ok(b.f, 'and the focus with it');
            await key('ArrowLeft');
            for (let i = 0; i < 40; i++) { await key('Tab'); assert.ok((await insideTop()).inside, `Tab ${i + 1}: focus left Edit member`); }
            for (let i = 0; i < 40; i++) { await key('Tab', 8); assert.ok((await insideTop()).inside, `Shift+Tab ${i + 1}: focus left Edit member`); }
            await key('Escape'); await waitFor(`!window.__nt.dlg(${N.member})`, 'closes', 4000);
        });
        await S.run('Escape closes New team (when no menu or member dialog is open) and the focus goes back to the button that opened it', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200);
            const opened = await ev(`(() => { const b = [...document.querySelectorAll('button, a')].filter(e => e.getClientRects().length > 0).find(e => /^\\+?\\s*New (agent|team)/i.test((e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim())); if (!b) return false; window.__qaOpener = b; b.focus(); b.click(); return true; })()`);
            assert.ok(opened, 'a visible New agent button to open the launch dialog with');
            await waitFor(`!!document.querySelector('#launch-step-chooser [data-arg="team"]') && document.querySelector('#launch-step-chooser [data-arg="team"]').getClientRects().length > 0`, 'the chooser', 6000);
            await ev(`document.querySelector('#launch-step-chooser [data-arg="team"]').click(); true`); await waitFor(`!!window.__nt.dlg(${N.team})`, 'New team', 5000);
            await key('Escape'); await waitFor(`!window.__nt.dlg(${N.team})`, 'Escape closes New team', 4000);
            assert.ok(await ev(`document.activeElement === window.__qaOpener`), 'focus is back on the button that opened the dialog');
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
