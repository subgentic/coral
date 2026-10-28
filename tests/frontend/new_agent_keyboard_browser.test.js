// New Agent and Restart Session by keyboard and screen reader (#7374, #7376; IA v4), written failing-first by QA for the redesign (#7392): Enter in the folder is Next, Escape closes, Tab stays inside the dialog, the step 3 tablist
// has the tab roles (one tab stop, arrows move and select, Home and End), the segmented controls and Mode cards are radiogroups (one checked, arrows move the choice), every control in every step and tab has an accessible
// name, the dialog is modal and named, and each step is said once in a polite status. Controls by role and name (helpers/new_agent.js). 1280 px, isolated dev server; the phone and 200% views are in new_agent_dialog_size.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const { Input } = client;
    const S = scenarios();
    const KEYS = { Enter: [13, '\r'], Escape: [27], Tab: [9], ArrowRight: [39], ArrowLeft: [37], ArrowDown: [40], ArrowUp: [38], Home: [36], End: [35], ' ': [32, ' '] };
    const key = async (k, mods = 0) => { const [vk, text] = KEYS[k]; for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: vk, modifiers: mods, ...(type === 'keyDown' && text ? { text } : {}) }); await settle(80); };
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx}`); };
    const active = () => ev(`(() => { const a = document.activeElement; const d = window.__na.dialog(); return { inside: !!(d && a && d.contains(a)), name: a ? (window.__na.name(a) || a.tagName) : '', role: a ? a.getAttribute('role') : null, tag: a ? a.tagName : '' }; })()`);
    const focusEl = (sel, rx) => ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.focus(); return document.activeElement === e; })()`);
    const toStep3 = async () => {
        await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        for (const s of [2, 3]) { await click('button', N.next); await waitFor(`/Step ${s} of 3/.test(window.__na.dialog().textContent)`, `step ${s}`, 4000); }
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev);
        await openNewAgent(ev, waitFor).catch(() => {});

        await S.run('the dialog is modal and named: role=dialog, aria-modal=true, name "New agent", and the keyboard starts inside it', async () => {
            const d = await ev(`(() => { const d = window.__na.dialog(); return d ? { modal: d.getAttribute('aria-modal'), name: window.__na.name(d) } : null; })()`);
            assert.ok(d, 'role=dialog named New agent'); assert.equal(d.modal, 'true', 'aria-modal'); assert.match(d.name, /^New agent$/, `the dialog is named "New agent" on its steps (it is "${d.name}")`); assert.ok((await active()).inside, 'focus starts inside the dialog');
        });
        await S.run('Enter in the folder is Next; with no folder it does not advance', async () => {
            await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); // New agent now opens with a folder (#10034): this is the person who cleared it
            await focusEl('input', N.folder); await key('Enter');
            assert.match(await ev(`window.__na.dialog().textContent`), /Step 1 of 3/, 'no folder: still step 1');
            await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`);
            await key('Enter'); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'Enter is Next', 4000);
            assert.ok((await active()).inside, 'after Next the focus is still inside the dialog (not on the page behind)');
        });
        await S.run('each step is said once in a polite status ("Step 2 of 3: ...", then "Step 3 of 3: ...")', async () => {
            const say = () => ev(`(() => { const d = window.__na.dialog(); return [...d.querySelectorAll('[aria-live=polite],[role=status]')].map(e => window.__na.text(e)).join(' | '); })()`);
            assert.match(await say(), /Step 2 of 3/, 'step 2 is announced');
            await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000); await settle(200);
            assert.match(await say(), /Step 3 of 3/, 'step 3 is announced');
        });
        await S.run('on a phone (the sections are a select) Next and Back put the focus on the new step\'s first control, never on the page body (#8432)', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200);
            await openNewAgent(ev, waitFor);
            const where = () => ev(`(() => { const a = document.activeElement; const d = window.__na.dialog(); return { inside: !!(d && a && d.contains(a)), body: a === document.body, tag: a ? a.tagName : '', cls: a ? String(a.className) : '', id: a ? a.id : '', visible: !!a && a.getClientRects().length > 0 }; })()`);
            await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await click('button', N.next); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000); await settle(200);
            let w = await where(); assert.ok(w.inside && !w.body && w.visible, 'Next to the persona step: ' + JSON.stringify(w));
            await click('button', N.next); await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000); await settle(200);
            w = await where(); assert.ok(w.inside && !w.body && w.visible, 'Next to the settings step: the focus is on a visible control of it, not on the page body: ' + JSON.stringify(w));
            assert.equal(w.tag, 'SELECT', 'where the sections are a select, that select takes the focus: ' + JSON.stringify(w));
            await click('button', /^Back$/); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'back to step 2', 4000); await settle(200);
            w = await where(); assert.ok(w.inside && !w.body && w.visible, 'Back to the persona step: ' + JSON.stringify(w));
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200);
            await openNewAgent(ev, waitFor); await toStep3();
        });
        await S.run('step 3 tabs are real tabs: a tablist with three tabs, aria-selected on one, roving tabindex, each tab controls a tabpanel named by it', async () => {
            const t = await ev(`(() => { const tl = window.__na.dialog().querySelector('[role=tablist]'); if (!tl) return null; return { orientation: tl.getAttribute('aria-orientation'), tabs: [...tl.querySelectorAll('[role=tab]')].map(x => ({ name: window.__na.name(x), sel: x.getAttribute('aria-selected'), tab: x.tabIndex, ctrl: (() => { const p = document.getElementById(x.getAttribute('aria-controls') || ''); return p ? { role: p.getAttribute('role'), by: p.getAttribute('aria-labelledby') === x.id } : null; })() })) }; })()`);
            assert.ok(t, 'a role=tablist'); assert.equal(t.tabs.length, 3);
            assert.equal(t.tabs.filter(x => x.sel === 'true').length, 1, 'one selected tab');
            assert.deepEqual(t.tabs.map(x => x.tab).sort(), [-1, -1, 0], 'one tab stop (roving tabindex)');
            for (const x of t.tabs) { assert.ok(x.ctrl, `${x.name}: aria-controls points to a panel`); assert.equal(x.ctrl.role, 'tabpanel', `${x.name}: the panel is a tabpanel`); assert.ok(x.ctrl.by, `${x.name}: the panel is labelled by its tab`); }
        });
        await S.run('tablist keys: the arrows along its axis move and select (wrapping), Home and End go to the first and last', async () => {
            const vertical = await ev(`window.__na.dialog().querySelector('[role=tablist]').getAttribute('aria-orientation') === 'vertical'`);
            const [next, prev] = vertical ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
            const cur = () => ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => x.getAttribute('aria-selected') === 'true'); return { name: window.__na.name(t), focused: document.activeElement === t }; })()`);
            await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => x.getAttribute('aria-selected') === 'true'); t.focus(); return true; })()`);
            assert.equal((await cur()).name, 'Agent');
            await key(next); assert.deepEqual(await cur(), { name: 'Permissions', focused: true }, `${next} selects and focuses the next tab`);
            await key(next); assert.equal((await cur()).name, 'Advanced');
            await key(next); assert.equal((await cur()).name, 'Agent', `${next} wraps to the first`);
            await key(prev); assert.equal((await cur()).name, 'Advanced', `${prev} wraps to the last`);
            await key('Home'); assert.equal((await cur()).name, 'Agent', 'Home');
            await key('End'); assert.equal((await cur()).name, 'Advanced', 'End');
            await key('Home');
        });
        await S.run('Provider, Thinking and Mode are radiogroups: one aria-checked, one tab stop, arrows move the choice and the focus, Space chooses', async () => {
            const group = async (rx, tabName) => {
                await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === ${JSON.stringify(tabName)}); t.click(); return true; })()`); await settle(200);
                const info = await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].filter(window.__na.vis).find(e => ${rx}.test(window.__na.name(e))); if (!g) return null; return window.__na.radios(g).map(r => ({ n: window.__na.radioName(r), c: window.__na.isChecked(r) ? 'true' : 'false', t: r.tabIndex, native: r.tagName === 'INPUT' })); })()`);
                assert.ok(info && info.length >= 2, `${rx}: a radiogroup of radios on the ${tabName} tab`);
                assert.equal(info.filter(r => r.c === 'true').length, 1, `${rx}: exactly one aria-checked`);
                if (!info[0].native) assert.equal(info.filter(r => r.t === 0).length, 1, `${rx}: one tab stop`); // a native radio group has one tab stop by itself
                const checked = () => ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].filter(window.__na.vis).find(e => ${rx}.test(window.__na.name(e))); const r = window.__na.radios(g); const i = r.findIndex(x => window.__na.isChecked(x)); return { i, focused: document.activeElement === r[i], n: r.length }; })()`);
                await ev(`(() => { const g = [...window.__na.dialog().querySelectorAll('[role=radiogroup]')].filter(window.__na.vis).find(e => ${rx}.test(window.__na.name(e))); window.__na.radios(g).find(x => window.__na.isChecked(x)).focus(); return true; })()`);
                const a = await checked(); await key('ArrowRight'); const b = await checked();
                assert.equal(b.i, (a.i + 1) % a.n, `${rx}: ArrowRight moves the choice to the next`); assert.ok(b.focused, `${rx}: and the focus with it`);
                await key('ArrowLeft'); assert.equal((await checked()).i, a.i, `${rx}: ArrowLeft moves back`);
                await key('ArrowDown'); assert.equal((await checked()).i, (a.i + 1) % a.n, `${rx}: ArrowDown also moves to the next`);
                await key('ArrowUp');
            };
            await group(N.provider, 'Agent'); await group(N.thinking, 'Agent'); await group(N.mode, 'Permissions');
        });
        await S.run('no control in any step or tab is without an accessible name, and every tab panel that is shown has a name', async () => {
            const bad = async () => ev(`(() => { const d = window.__na.dialog(); return [...d.querySelectorAll('button, input, select, textarea, [role=radio], [role=tab], summary')].filter(window.__na.vis).filter(e => e.type !== 'hidden' && !window.__na.name(e)).map(e => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')); })()`);
            for (const t of N.tabs) { await ev(`(() => { const e = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => window.__na.name(x) === ${JSON.stringify(t)}); e.click(); return true; })()`); await settle(200); assert.deepEqual(await bad(), [], `step 3, ${t}: unnamed controls`); }
            await click('button', N.back); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000); assert.deepEqual(await bad(), [], 'step 2: unnamed controls');
            await click('button', N.back); await waitFor(`/Step 1 of 3/.test(window.__na.dialog().textContent)`, 'step 1', 4000); assert.deepEqual(await bad(), [], 'step 1: unnamed controls');
        });
        await S.run('Tab and Shift+Tab stay inside the dialog (40 presses each way)', async () => {
            await focusEl('input', N.folder);
            for (let i = 0; i < 40; i++) { await key('Tab'); assert.ok((await active()).inside, `Tab ${i + 1}: focus left the dialog (on ${(await active()).name})`); }
            for (let i = 0; i < 40; i++) { await key('Tab', 8); assert.ok((await active()).inside, `Shift+Tab ${i + 1}: focus left the dialog`); }
        });
        await S.run('Escape closes the dialog and the focus goes back to the button that opened it (a real opener: the New agent button)', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await settle(200);
            const opened = await ev(`(() => { const b = [...document.querySelectorAll('button, a')].filter(e => e.getClientRects().length > 0).find(e => /^\\+?\\s*New agent$/i.test((e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim())); if (!b) return false; window.__qaOpener = b; b.focus(); b.click(); return true; })()`);
            assert.ok(opened, 'a visible New agent button to open the dialog with');
            await waitFor(`!!window.__na.dialog()`, 'the dialog opens from the button', 6000);
            await key('Escape'); await waitFor(`!window.__na.dialog()`, 'Escape closes New agent', 4000);
            assert.ok(await ev(`document.activeElement === window.__qaOpener`), 'focus is back on the New agent button');
        });
        await S.run('Restart Session: modal and named, opens on the persona and Next opens the Model tab, the same tab keys and radiogroup keys work, Escape closes it', async () => {
            await ev(`window.__m.add('qa-agent', 'A', 3, { sleeping: false }); T.render.renderLiveSessions(T.state.liveSessions); true`);
            await select('qa-agent');
            await ev(`(async () => { await window.restartSession(); return true; })()`);
            await waitFor(`!!window.__na.dialog() && /^Restart/i.test(window.__na.name(window.__na.dialog()))`, 'Restart Session dialog', 6000);
            assert.equal(await ev(`window.__na.dialog().getAttribute('aria-modal')`), 'true');
            await ev(`document.getElementById('restart-next').click(); true`); // step 1 is the persona page; the tabs are step 2
            await ev(`(() => { const t = [...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => x.getAttribute('aria-selected') === 'true'); t.focus(); return true; })()`);
            const vertical = await ev(`window.__na.dialog().querySelector('[role=tablist]').getAttribute('aria-orientation') === 'vertical'`);
            await key(vertical ? 'ArrowDown' : 'ArrowRight');
            assert.equal(await ev(`window.__na.name([...window.__na.dialog().querySelectorAll('[role=tab]')].find(x => x.getAttribute('aria-selected') === 'true'))`), 'Permissions', 'the second Restart tab is Permissions');
            await key('Escape'); await waitFor(`!window.__na.dialog()`, 'Escape closes Restart', 4000);
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
