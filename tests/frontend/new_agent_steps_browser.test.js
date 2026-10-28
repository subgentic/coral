// New Agent is three steps (#7374, #7376; UI/UX's IA v4, notes a8d59b25, mockup c5294957), written failing-first by QA for the redesign (#7392): 1 Where it launches (folder, Recent: chips, Machine only with several
// machines), 2 Persona (persona first, then Name, then the Behavior prompt), 3 The agent (tabs Agent, Permissions, Advanced). Cancel is the leftmost control of every footer, the primary the rightmost, Back and Next
// move between steps and keep what was typed, Next says why it is off when there is no folder, the recap sits above the footer from step 2. Controls are found by role and accessible name (helpers/new_agent.js), never by id.
// 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stepLine, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = scenarios();
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx} in the dialog`); };
    const setFolder = v => ev(`(() => { const i = window.__na.find('input', ${N.folder}); if (!i) return false; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const has = async (sel, rx) => ev(`!!window.__na.find(${JSON.stringify(sel)}, ${rx})`);
    const btn = (rx) => ev(`(() => { const e = window.__na.find('button', ${rx}); return e ? window.__na.box(e) : null; })()`);
    const reopen = async () => { await ev(`window.hideLaunchModal && window.hideLaunchModal(); true`); await openNewAgent(ev, waitFor); };
    const toStep = async (n, folder = '/work/payments-app') => {
        await setFolder(folder);
        for (let s = 1; s < n; s++) { await click('button', N.next); await waitFor(`/Step ${s + 1} of 3/.test(window.__na.dialog() ? window.__na.dialog().textContent : '')`, `step ${s + 1} of 3`, 4000); }
    };
    // Cancel is the first and leftmost footer control, the primary one the rightmost, both at the footer's one row.
    const footerOrder = async (primary, label) => {
        const b = await ev(`window.__na.buttons()`);
        const cancel = b.find(x => N.cancel.test(x.name)), prim = b.find(x => primary.test(x.name));
        assert.ok(cancel, `${label}: Cancel is in the footer`); assert.ok(prim, `${label}: ${primary} is in the footer`);
        for (const x of b.filter(y => /^(Back|Next|Launch|Restart)$/i.test(y.name))) assert.ok(cancel.x < x.x, `${label}: Cancel (x ${cancel.x}) is left of ${x.name} (x ${x.x})`);
        for (const x of b.filter(y => /^(Cancel|Back)$/i.test(y.name))) assert.ok(prim.x >= x.x, `${label}: ${prim.name} is the rightmost, right of ${x.name}`);
        assert.ok(Math.abs(cancel.y - prim.y) < 4, `${label}: Cancel and ${prim.name} are on one row`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await installNA(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app', '/work/website', '/work/docs'])); true`);
        await openNewAgent(ev, waitFor).catch(() => {});

        await S.run('the dialog is a role=dialog named "New agent", and it opens on "Step 1 of 3: Where it launches"', async () => {
            assert.ok(await ev(`!!window.__na.dialog()`), 'no visible role=dialog named "New agent"');
            assert.match(await ev(`window.__na.name(window.__na.dialog())`), /^New agent$/, 'the dialog is named exactly "New agent" while the three steps are open');
            assert.match(await stepLine(ev), /^Step 1 of 3: Where it launches/);
        });
        await S.run('step 1 is the folder alone: Folder (required) with Browse and Recent: chips, Cancel and Next, no Back, no tabs, no Machine with one machine', async () => {
            assert.ok(await has('input', N.folder), 'Folder field');
            assert.ok(await ev(`(() => { const i = window.__na.find('input', ${N.folder}); return i.required || i.getAttribute('aria-required') === 'true' || /required/i.test(window.__na.name(i)); })()`), 'the folder says it is required (aria-required, required, or in its name)');
            assert.ok(await has('button', /^Browse/i), 'Browse');
            for (const rx of [N.cancel, N.next]) assert.ok(await has('button', rx), `${rx} button`);
            assert.ok(!(await has('button', N.back)), 'no Back on step 1');
            assert.ok(!(await has('button', N.launch)), 'Launch is only on step 3 (the approved plan)');
            assert.ok(!(await ev(`!![...window.__na.dialog().querySelectorAll('[role=tablist]')].filter(window.__na.vis).length`)), 'no tabs on step 1');
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
        await S.run('with no folder Next is on; pressing it says "Choose a folder" under the field and on one red line, and it does not advance; nothing is said before the first press', async () => {
            await reopen(); await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const state = () => ev(`(() => { const b = window.__na.find('button', ${N.next}); const f = document.getElementById('launch-dir'); const e = f.closest('.sv-row').querySelector('.sv-error'); return { off: b.disabled || b.getAttribute('aria-disabled') === 'true', status: window.__na.text(document.getElementById('launch-agent-status')), error: e.hidden ? '' : e.textContent, focus: document.activeElement === f }; })()`);
            let n = await state(); assert.ok(!n.off, 'Next is on'); assert.equal(n.status, '', 'nothing before the first press'); assert.equal(n.error, '');
            await click('button', N.next); n = await state();
            assert.ok(!n.off && n.focus, 'Next stays on and the folder takes the focus'); assert.equal(n.status, 'Choose a folder', 'one line above the buttons'); assert.match(n.error, /Choose a folder/, 'and the error under the field');
            assert.match(await stepLine(ev), /^Step 1 of 3/, 'pressing Next with no folder stays on step 1');
        });
        await S.run('a machine selector is there with several machines and only then (any select about the machine or server on step 1)', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); T.state.hub = true; T.state.cloud = true; T.state.serversKnown = true; T.state.servers = [{ id: 'm1', label: 'build-server', status: 'online', version: '1.4.6', last_seen: new Date().toISOString() }]; true`);
            await openNewAgent(ev, waitFor);
            assert.ok(await has('select', /machine|server/i), 'a select for the machine with two machines (this computer and build-server)');
            await ev(`window.hideLaunchModal(); T.state.servers = []; T.state.hub = false; T.state.cloud = false; true`);
            await openNewAgent(ev, waitFor);
            assert.ok(!(await has('select', /machine|server/i)), 'no machine select with this computer alone');
        });
        await S.run('that select is named "Machine" (the design\'s name; a screen reader hears it)', async () => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); T.state.hub = true; T.state.cloud = true; T.state.serversKnown = true; T.state.servers = [{ id: 'm1', label: 'build-server', status: 'online', version: '1.4.6', last_seen: new Date().toISOString() }]; true`);
            await openNewAgent(ev, waitFor);
            assert.ok(await has('select', N.machine), 'a select named exactly Machine');
            await ev(`window.hideLaunchModal(); T.state.servers = []; T.state.hub = false; T.state.cloud = false; true`);
        });
        await S.run('step 1 footer: Cancel leftmost, Next rightmost, one row', async () => { await reopen(); await setFolder('/work/payments-app'); await footerOrder(N.next, 'step 1'); });

        await S.run('step 2 is "Step 2 of 3: Persona. In /work/payments-app": persona first, then Name, then the Behavior prompt, with Back, Cancel and Next and no tabs', async () => {
            await reopen(); await toStep(2);
            assert.match(await stepLine(ev), /^Step 2 of 3: Persona\. In \/work\/payments-app/);
            const y = await ev(`(() => { const f = (s, rx) => { const e = window.__na.find(s, rx); return e ? window.__na.box(e).y : null; }; return { persona: f('select', ${N.persona}), name: f('input', ${N.name}), prompt: f('textarea', ${N.prompt}) }; })()`);
            for (const k of ['persona', 'name', 'prompt']) assert.notEqual(y[k], null, `${k} is on step 2`);
            assert.ok(y.persona < y.name && y.name < y.prompt, `the order is Persona, Name, Behavior prompt (y ${JSON.stringify(y)})`);
            for (const rx of [N.back, N.cancel, N.next]) assert.ok(await has('button', rx), `${rx} on step 2`);
            assert.ok(!(await ev(`!![...window.__na.dialog().querySelectorAll('[role=tablist]')].filter(window.__na.vis).length`)), 'no tabs on step 2');
            assert.ok(!(await has('button', N.launch)), 'Launch is only on step 3 (the approved plan)');
            await footerOrder(N.next, 'step 2');
        });
        await S.run('step 2: a persona fills the name and the prompt, Blank leaves them for typing, and the two static lines say so', async () => {
            const pick = (rx) => ev(`(() => { const s = window.__na.find('select', ${N.persona}); const o = [...s.options].find(o => ${rx}.test(o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.ok(await pick(/^Blank/i), 'a Blank option first in the persona select');
            assert.match(await ev(`window.__na.dialog().textContent.replace(/\\s+/g, ' ')`), /Choose a persona above and its name goes here, or type your own\./);
            const name = await ev(`(() => { const s = window.__na.find('select', ${N.persona}); const o = [...s.options].find(o => !/^Blank/i.test(o.textContent) && o.value !== ''); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.textContent.trim(); })()`);
            assert.ok(name, 'at least one persona to choose');
            await waitFor(`window.__na.find('input', ${N.name}).value.length > 0 && window.__na.find('textarea', ${N.prompt}).value.length > 0`, 'the persona fills the name and the prompt', 4000);
            assert.match(await ev(`window.__na.dialog().textContent.replace(/\\s+/g, ' ')`), /Filled from the persona\. Change it if you want a different name\./);
            assert.match(await ev(`window.__na.dialog().textContent.replace(/\\s+/g, ' ')`), /A persona fills the name and the prompt below, and may set the provider, model and permissions on the next step\./);
        });
        await S.run('step 2: the recap above the buttons names the agent once there is a name', async () => {
            const r = await ev(`(() => { const d = window.__na.dialog(); const t = d.textContent.replace(/\\s+/g, ' '); return t; })()`);
            assert.match(r, /: Claude, \/work\/payments-app, default model, \w+ mode/, 'the recap reads "<name>: Claude, <folder>, default model, <Mode> mode"');
        });
        await S.run('Back keeps what was typed and returns to step 1 with the folder', async () => {
            await ev(`(() => { const i = window.__na.find('input', ${N.name}); i.value = 'QA Engineer'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await click('button', N.back);
            await waitFor(`/Step 1 of 3/.test(window.__na.dialog().textContent)`, 'back on step 1', 4000);
            assert.equal(await ev(`window.__na.find('input', ${N.folder}).value`), '/work/payments-app');
            await click('button', N.next);
            await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2 again', 4000);
            assert.equal(await ev(`window.__na.find('input', ${N.name}).value`), 'QA Engineer', 'the name typed is kept');
        });

        const shotIf = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        await S.run('step 3 is "The agent": tabs Agent, Permissions, Advanced as one tablist, Back, Cancel and Launch, no Next, and the recap above the footer', async () => {
            await click('button', N.next);
            await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3 of 3', 4000);
            assert.match(await stepLine(ev), /^Step 3 of 3: The agent/);
            const tabs = await ev(`(() => { const d = window.__na.dialog(); const tl = d.querySelector('[role=tablist]'); return tl ? [...tl.querySelectorAll('[role=tab]')].filter(window.__na.vis).map(t => ({ name: window.__na.name(t), selected: t.getAttribute('aria-selected') })) : null; })()`);
            assert.ok(tabs, 'a role=tablist on step 3');
            assert.deepEqual(tabs.map(t => t.name), N.tabs, 'the tabs, in order');
            assert.equal(tabs[0].selected, 'true', 'Agent is the open tab');
            for (const rx of [N.back, N.cancel, N.launch]) assert.ok(await has('button', rx), `${rx} on step 3`);
            assert.ok(!(await has('button', N.next)), 'no Next on step 3');
            await footerOrder(N.launch, 'step 3');
            assert.match(await ev(`window.__na.dialog().textContent.replace(/\\s+/g, ' ')`), /QA Engineer: Claude, \/work\/payments-app, default model, \w+ mode/, 'the recap');
            // the footer says what the chosen mode allows (Desktop tester, #10000), and follows the choice
            const noteOf = () => ev(`(() => { const n = window.__na.dialog().querySelector('.launch-recap-note'); return n ? n.textContent : ''; })()`);
            assert.match(await noteOf(), /^\w+ mode allows: [a-z].{10,}\.$/, 'a line under the recap says what the mode allows');
            await ev(`(() => { const sel = window.__na.dialog().querySelector('.acf-permission-mode'); sel.value = 'plan'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`/^Plan mode allows: reads only/.test((window.__na.dialog().querySelector('.launch-recap-note') || {}).textContent || '')`, 'the line follows the mode', 4000);
            // Auto is not the same on every CLI (Security's review): safety checks are Claude's; Codex has its sandbox; Antigravity and Gemini skip every prompt and check; Pi has no permissions
            const as = async (type, mode) => { await ev(`(() => { const d = window.__na.dialog(), t = d.querySelector('.acf-agent-type'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change', { bubbles: true })); const sel = d.querySelector('.acf-permission-mode'); sel.value = ${JSON.stringify(mode)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await new Promise(r => setTimeout(r, 250)); return noteOf(); }; // sleep-ok: the recap follows
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

        // phone: every footer button is 44 px tall, Cancel at the left, the primary filling the right (v4 section 1)
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev);
        await S.run('on a phone: every footer button of every step is at least 44 px tall, Cancel at the left edge of the footer, and no sideways scroll', async () => {
            await openNewAgent(ev, waitFor);
            for (const n of [1, 2, 3]) {
                if (n === 1) await setFolder('/work/payments-app'); else await click('button', N.next);
                await waitFor(`/Step ${n} of 3/.test(window.__na.dialog().textContent)`, `phone step ${n}`, 4000);
                const b = await ev(`window.__na.buttons().filter(x => /^(Cancel|Back|Next|Launch)$/i.test(x.name))`);
                assert.ok(b.length >= 2, `phone step ${n}: footer buttons`);
                for (const x of b) assert.ok(x.h >= 44, `phone step ${n}: ${x.name} is ${x.h}px tall`);
                const cancel = b.find(x => /^Cancel$/i.test(x.name)); const pl = await ev(`window.__na.box(window.__na.panel()).x`); assert.ok(cancel.x - pl <= 24, `phone step ${n}: Cancel is within 24 px of the dialog's left edge (it is ${Math.round(cancel.x - pl)} px in)`);
                assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `phone step ${n}: no sideways scroll`);
                if (n === 3) { assert.ok(await ev(`(() => { const d = window.__na.dialog(), n = d.querySelector('.launch-recap-note'), r = n && n.closest('.launch-recap'); if (!n || !r) return false; const a = n.getBoundingClientRect(), b = r.getBoundingClientRect(); return a.height > 0 && a.bottom <= b.bottom + 1 && r.scrollHeight <= r.clientHeight + 1; })()`), 'phone step 3: the mode note is whole inside the recap, not cut off by its line clamp'); await shotIf('new-agent-mode-note-390'); }
            }
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
