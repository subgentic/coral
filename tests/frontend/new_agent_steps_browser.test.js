// New Agent is one page (#15911, LA1b of the Settings and New agent redesign; it was three steps, #7374): Folder (Recent: chips, Machine only with several machines), Persona first, a closed 'Name and instructions', a closed 'More options' (tabs Agent, Permissions, Advanced),
// the Runs as line above the footer, Cancel beside Launch at the right (#16361) and Launch the rightmost. No Back and no Next: the page is what Next used to open. Controls are found by role and accessible name (helpers/new_agent.js), never by id.
// Written failing-first by QA for the three-step redesign (#7392); rewritten for the one page. 1280 and 390 px, isolated dev server.
// 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stepLine, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { existing: recentsExist } = require('./helpers/recent_dirs');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = scenarios();
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx} in the dialog`); };
    const setFolder = v => ev(`(() => { const i = window.__na.find('input', ${N.folder}); if (!i) return false; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const has = async (sel, rx) => ev(`!!window.__na.find(${JSON.stringify(sel)}, ${rx})`);
    const btn = (rx) => ev(`(() => { const e = window.__na.find('button', ${rx}); return e ? window.__na.box(e) : null; })()`);
    const reopen = async () => { await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await openNewAgent(ev, waitFor); };
    // Cancel sits at the right with the primary, like every dialog (#15816, #16361): Back (when there is one) first, then Cancel, the primary one the rightmost, all on the footer's one row. The one page has no Back.
    const footerOrder = async (primary, label) => {
        const b = await ev(`window.__na.buttons()`);
        const cancel = b.find(x => N.cancel.test(x.name)), prim = b.find(x => primary.test(x.name));
        assert.ok(cancel, `${label}: Cancel is in the footer`); assert.ok(prim, `${label}: ${primary} is in the footer`);
        for (const x of b.filter(y => /^Back$/i.test(y.name))) assert.ok(x.x < cancel.x, `${label}: Back (x ${x.x}) is left of Cancel (x ${cancel.x})`);
        assert.ok(cancel.x < prim.x, `${label}: Cancel (x ${cancel.x}) is left of ${prim.name} (x ${prim.x}), together at the right`);
        for (const x of b.filter(y => /^(Cancel|Back)$/i.test(y.name))) assert.ok(prim.x >= x.x, `${label}: ${prim.name} is the rightmost, right of ${x.name}`);
        assert.ok(Math.abs(cancel.y - prim.y) < 4, `${label}: Cancel and ${prim.name} are on one row`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await installNA(ev);
        await recentsExist(ev); await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app', '/work/website', '/work/docs'])); true`);
        await openNewAgent(ev, waitFor).catch(() => {});
        const open = (id) => ev(`(() => { const d = document.getElementById(${JSON.stringify(id)}); d.open = true; d.dispatchEvent(new Event('toggle')); return true; })()`);
        const shotIf = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        const tablist = () => ev(`(() => { const d = window.__na.dialog(); const tl = [...d.querySelectorAll('[role=tablist]')].find(window.__na.vis); return tl ? [...tl.querySelectorAll('[role=tab]')].filter(window.__na.vis).map(t => ({ name: window.__na.name(t), selected: t.getAttribute('aria-selected') })) : null; })()`);

        await S.run('the dialog is a role=dialog named "New agent", one page: no "Step n of 3" line, no Back, no Next', async () => {
            assert.ok(await ev(`!!window.__na.dialog()`), 'no visible role=dialog named "New agent"');
            assert.match(await ev(`window.__na.name(window.__na.dialog())`), /^New agent$/, 'the dialog is named exactly "New agent"');
            assert.equal(await stepLine(ev), '', 'no Step n of 3 line');
            assert.ok(!(await has('button', N.next)) && !(await has('button', N.back)), 'no Next and no Back');
        });
        await S.run('the page has Folder (required) with Browse and Recent: chips, the persona, Cancel and Launch, no tabs until More options opens, no Machine with one machine', async () => {
            assert.ok(await has('input', N.folder), 'Folder field');
            assert.ok(await ev(`(() => { const i = window.__na.find('input', ${N.folder}); return i.required || i.getAttribute('aria-required') === 'true' || /required/i.test(window.__na.name(i)); })()`), 'the folder says it is required (aria-required, required, or in its name)');
            assert.ok(await has('button', /^Browse/i), 'Browse');
            assert.ok(await has('select', N.persona), 'the persona select is on the page');
            for (const rx of [N.cancel, N.launch]) assert.ok(await has('button', rx), `${rx} button`);
            assert.equal(await tablist(), null, 'no tabs while More options is closed');
            assert.ok(!(await has('select', N.machine)), 'no Machine selector with one machine');
        });
        await S.run('the three recent folders are a group named "Recent folders" that starts with the word "Recent:", each button showing the folder\'s own name', async () => {
            const g = await ev(`(() => { const d = window.__na.dialog(); const g = [...d.querySelectorAll('[role=group]')].find(e => /^Recent folders$/i.test(window.__na.name(e))); return g ? { text: window.__na.text(g), buttons: [...g.querySelectorAll('button')].map(b => window.__na.text(b)) } : null; })()`);
            assert.ok(g, 'a role=group named "Recent folders"');
            assert.match(g.text, /^Recent:/, 'the group starts with "Recent:"');
            assert.deepEqual(g.buttons, ['payments-app', 'website', 'docs']);
            await click('button', /^payments-app$/);
            assert.equal(await ev(`window.__na.find('input', ${N.folder}).value`), '/work/payments-app', 'pressing a chip puts the whole path in the field');
        });
        await S.run('with no folder Launch is on; pressing it says "Choose a folder" under the field, the folder takes the focus, and the dialog stays open', async () => {
            await reopen(); await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const state = () => ev(`(() => { const b = window.__na.find('button', ${N.launch}); const f = document.getElementById('launch-dir'); const e = f.closest('.sv-row').querySelector('.sv-error'); return { off: b.disabled || b.getAttribute('aria-disabled') === 'true', error: e.hidden ? '' : e.textContent, focus: document.activeElement === f }; })()`);
            let n = await state(); assert.ok(!n.off, 'Launch is on'); assert.equal(n.error, '');
            await click('button', N.launch); n = await state();
            assert.ok(!n.off && n.focus, 'Launch stays on and the folder takes the focus'); assert.match(n.error, /Choose a folder/, 'and the error under the field');
            assert.ok(await ev(`!!window.__na.dialog()`), 'the dialog stays open');
        });
        await S.run('on a Hub the first thing is Which computer? with several machines and only then (no machine select on the page either way)', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); T.state.hub = true; T.state.cloud = true; T.state.serversKnown = true; T.state.servers = [{ id: 'm1', label: 'build-server', status: 'online', version: '1.4.6', last_seen: new Date().toISOString() }]; true`);
            await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
            await waitFor(`(() => { const s = document.getElementById('launch-step-computer'); return !!s && getComputedStyle(s).display !== 'none' && document.querySelectorAll('#launch-computer-list .launch-computer-pick').length >= 1; })()`, 'the Which computer? step', 6000);
            assert.ok(await ev(`/build-server/.test(document.getElementById('launch-computer-list').textContent) && document.getElementById('launch-computer-title').textContent === 'Which computer?'`), 'the step lists the computers and is named Which computer?');
            await ev(`document.querySelector('#launch-computer-list .launch-computer-pick:not(:disabled)').click(); true`);
            await waitFor(`!!window.__na.dialog()`, 'the New agent dialog after Select', 6000);
            assert.ok(!(await has('select', /computer|machine|server/i)), 'no machine select on the page: the choice is a chip, On build-server, with Change');
            await ev(`window.hideLaunchModal(); T.state.servers = []; T.state.hub = false; T.state.cloud = false; true`);
            await openNewAgent(ev, waitFor);
            assert.ok(!(await has('select', /computer|machine|server/i)), 'no machine select with this computer alone');
            assert.ok(await ev(`getComputedStyle(document.getElementById('launch-step-computer')).display === 'none'`), 'and no Which computer? step with this computer alone');
        });
        await S.run('footer: Cancel then Launch together at the right, one row', async () => { await reopen(); await setFolder('/work/payments-app'); await footerOrder(N.launch, 'the page'); });
        await S.run('the persona comes first, then Name and instructions (closed: the name and the instructions show when it opens, in that order)', async () => {
            await reopen(); await setFolder('/work/payments-app');
            assert.ok(await has('select', N.persona), 'persona is on the page');
            assert.ok(!(await has('input', N.name)) && !(await has('textarea', N.prompt)), 'Name and the instructions are folded away until the person asks');
            await click('summary', /^Name and instructions$/);
            await waitFor(`!!window.__na.find('input', ${N.name}) && !!window.__na.find('textarea', ${N.prompt})`, 'the name and the instructions show', 4000);
            const y = await ev(`(() => { const f = (s, rx) => { const e = window.__na.find(s, rx); return e ? window.__na.box(e).y : null; }; return { persona: f('select', ${N.persona}), name: f('input', ${N.name}), prompt: f('textarea', ${N.prompt}) }; })()`);
            assert.ok(y.persona < y.name && y.name < y.prompt, `the order is Persona, Name, Instructions for this agent (y ${JSON.stringify(y)})`);
        });
        await S.run('a persona fills the name and the prompt, Blank leaves them for typing, and no static line says so (#10835)', async () => {
            const pick = (rx) => ev(`(() => { const s = window.__na.find('select', ${N.persona}); const o = [...s.options].find(o => ${rx}.test(o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.ok(await pick(/^Blank/i), 'a Blank option first in the persona select');
            assert.doesNotMatch(await ev(`window.__na.dialog().textContent.replace(/\\s+/g, ' ')`), /Choose a persona above|It fills in the name and prompt/);
            const name = await ev(`(() => { const s = window.__na.find('select', ${N.persona}); const o = [...s.options].find(o => !/^Blank/i.test(o.textContent) && o.value !== ''); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.textContent.trim(); })()`);
            assert.ok(name, 'at least one persona to choose');
            await waitFor(`window.__na.find('input', ${N.name}).value.length > 0 && window.__na.find('textarea', ${N.prompt}).value.length > 0`, 'the persona fills the name and the prompt', 4000);
            assert.doesNotMatch(await ev(`window.__na.dialog().textContent.replace(/\\s+/g, ' ')`), /Filled from the persona|It fills in the name and prompt/);
        });
        await S.run('the Runs as line above the buttons shows the four values the launch will use, from the first moment', async () => {
            const r = await ev(`(() => { const l = window.__na.dialog().querySelector('#launch-recap .runs-as'); return l ? [...l.querySelectorAll('.runs-as-ctl')].filter(c => !c.hidden).map(c => c.querySelector('.runs-as-name').textContent) : null; })()`);
            assert.deepEqual(r, ['Provider', 'Model', 'Thinking', 'Permission mode'], 'Runs as: Provider, Model, Thinking, Permission mode: ' + JSON.stringify(r));
        });
        await S.run('closing Name and instructions keeps what was typed (nothing is lost by folding it)', async () => {
            await ev(`(() => { const i = window.__na.find('input', ${N.name}); i.value = 'QA Engineer'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await ev(`document.getElementById('launch-persona-more').open = false; true`);
            await ev(`document.getElementById('launch-persona-more').open = true; true`);
            assert.equal(await ev(`window.__na.find('input', ${N.name}).value`), 'QA Engineer', 'the name typed is kept');
        });
        await S.run('More options opens the tabs Agent, Permissions, Advanced as one tablist, with the Agent tab open, and Launch stays', async () => {
            await click('summary', /^More options$/);
            await waitFor(`!![...window.__na.dialog().querySelectorAll('[role=tablist]')].find(window.__na.vis)`, 'the tabs', 4000);
            const tabs = await tablist();
            assert.deepEqual(tabs.map(t => t.name), N.tabs, 'the tabs, in order');
            assert.equal(tabs[0].selected, 'true', 'Agent is the open tab');
            for (const rx of [N.cancel, N.launch]) assert.ok(await has('button', rx), `${rx} stays`);
            await footerOrder(N.launch, 'the page with More options open');
            assert.ok(await ev(`!!window.__na.dialog().querySelector('#launch-recap .runs-as')`), 'the Runs as line');
            // the footer says what the chosen mode allows (Desktop tester, #10000), and follows the choice
            const noteOf = () => ev(`(() => { const n = window.__na.dialog().querySelector('.launch-recap-note'); return n ? n.textContent : ''; })()`);
            assert.match(await noteOf(), /^\w+ mode allows: [a-z].{10,}\.$/, 'a line under the recap says what the mode allows');
            await ev(`(() => { const sel = window.__na.dialog().querySelector('.acf-permission-mode'); sel.value = 'plan'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`/^Plan mode allows: reads only/.test((window.__na.dialog().querySelector('.launch-recap-note') || {}).textContent || '')`, 'the line follows the mode', 4000);
            // Auto is not the same on every CLI (Security's review): safety checks are Claude's; Codex has its sandbox; Antigravity and Gemini skip every prompt and check; Pi has no permissions
            const as = async (type, mode) => { await ev(`(() => { const d = window.__na.dialog(), t = d.querySelector('.acf-agent-type'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change', { bubbles: true })); const sel = d.querySelector('.acf-permission-mode'); sel.value = ${JSON.stringify(mode)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); return noteOf(); };
            assert.match(await as('claude', 'auto'), /^Auto mode allows: everything, with safety checks\.$/, 'Claude Auto has safety checks');
            assert.match(await as('codex', 'auto'), /workspace sandbox/, 'Codex Auto is its workspace sandbox');
            assert.equal(await as('agy', 'auto'), 'Auto mode allows: everything, with no prompts and no safety checks.', 'Antigravity Auto has no prompts and no safety checks');
            assert.equal(await as('pi', 'auto'), 'Pi has no permission prompts: it always acts on its own.', 'Pi has no permission system');
            await as('claude', 'plan');
            await shotIf('new-agent-mode-note-1280');
        });
        await S.run('Cancel closes the dialog', async () => {
            await click('button', N.cancel);
            await waitFor(`!window.__na.dialog()`, 'Cancel closes the dialog', 4000);
        });

        // phone: every footer button is 44 px tall, Cancel beside the primary at the right (#16361, LA1b)
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
        await S.run('on a phone: the footer buttons are at least 44 px tall, Cancel and Launch together at the right of the footer, no sideways scroll, with More options closed and open', async () => {
            await openNewAgent(ev, waitFor);
            await setFolder('/work/payments-app');
            for (const more of [false, true]) {
                if (more) { await click('summary', /^More options$/); await waitFor(`!![...window.__na.dialog().querySelectorAll('[role=tablist]')].find(window.__na.vis)`, 'phone tabs', 4000); }
                const b = await ev(`window.__na.buttons().filter(x => /^(Cancel|Launch)$/i.test(x.name))`);
                assert.equal(b.length, 2, `phone: footer buttons (more ${more})`);
                for (const x of b) assert.ok(x.h >= 44, `phone: ${x.name} is ${x.h}px tall`);
                const cancel = b.find(x => /^Cancel$/i.test(x.name)), go = b.find(x => /^Launch$/i.test(x.name)); const pr = await ev(`(() => { const r = window.__na.panel().getBoundingClientRect(); return r.right; })()`); assert.ok(cancel.x < go.x && go.x + go.w <= pr + 1 && pr - (go.x + go.w) <= 28, `phone: Cancel is left of Launch and the pair sits at the dialog's right edge (Launch ends ${Math.round(pr - (go.x + go.w))} px from it)`);
                assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `phone: no sideways scroll (more ${more})`);
            }
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
