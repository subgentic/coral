// Step 2 of New Agent: Save as persona and the Persona files menu (#7391; written by QA for the review, the gap Frontend named): Save as persona with no name says so and saves nothing, a name and a prompt save a
// persona that is then a choice of "Start from a persona" and fills the name and the prompt, a built-in preset's name is refused, and Persona files is a disclosure that opens to Export and Import by mouse and
// keyboard. Controls by role and accessible name (helpers/new_agent.js). 1280 px, isolated dev server (the runner puts the saved personas back after the suite).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, scenarios, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const { Input } = client;
    const S = scenarios();
    const click = async (sel, rx) => { assert.ok(await ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx}`); };
    const type = (sel, rx, v) => ev(`(() => { const e = window.__na.find(${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const toasts = () => ev(`[...document.querySelectorAll('.toast, [role=status], [role=alert]')].map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | ')`);
    const options = () => ev(`(() => { const s = window.__na.find('select', ${N.persona}); return s ? [...s.options].map(o => o.textContent.trim()) : null; })()`);
    const key = async (k, vk, text) => { for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && text ? { text } : {}) }); await settle(150); };
    const NAME = 'QA Persona ' + Date.now();
    // The persona this suite saves is a setting (saved_personas): put the settings back as found, and check that this one is (the runner's --fail-on-leak named it on the 168 Windows run, #7527).
    const { guardSettings } = require('./helpers/settings_guard');
    const guard = await guardSettings();
    const restoreAndCheck = async () => {
        await guard.restore();
        const now = await guardSettings();
        assert.equal(now.before.saved_personas || '', guard.before.saved_personas || '', 'saved_personas is back to what it was');
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewAgent(ev, waitFor);
        await type('input', N.folder, '/work/payments-app'); await click('button', N.next);
        await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);

        // Save as persona is in the More menu (#9998): open it, then press it
        const saveAsPersona = async () => {
            await ev(`(() => { const d = [...window.__na.dialog().querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))).closest('details'); d.open = true; return true; })()`); await settle(100);
            await click('button', /^Save as persona$/i);
            await ev(`[...window.__na.dialog().querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))).closest('details').open = false; true`);
        };
        await S.run('Save as persona with no name says "Enter a name before saving" and saves nothing', async () => {
            const before = await options(); assert.ok(before, 'the persona select');
            await saveAsPersona(); await settle(400);
            assert.match(await toasts(), /Enter a name before saving/, 'a message says why');
            assert.deepEqual(await options(), before, 'the persona list is unchanged');
        });
        await S.run('Save as persona with a built-in preset\'s name is refused', async () => {
            const builtin = await ev(`(() => { const s = window.__na.find('select', ${N.persona}); const o = [...s.options].map(o => o.textContent.trim()).find(t => t && !/^Blank/i.test(t)); return o || null; })()`);
            if (!builtin) return; // no built-in preset to test with
            await type('input', N.name, builtin); await type('textarea', N.prompt, 'x'); await saveAsPersona(); await settle(400);
            assert.match(await toasts(), /Can't overwrite a built-in preset|Saved persona/, 'the answer is a toast');
            if (/Saved persona/.test(await toasts())) assert.fail('a built-in preset\'s name was saved over');
        });
        await S.run('a name and a prompt: the persona is saved, listed in "Start from a persona", and choosing it fills the name and the prompt', async () => {
            await type('input', N.name, NAME); await type('textarea', N.prompt, 'You are the QA persona. Check every claim.');
            await saveAsPersona();
            await waitFor(`/Saved persona/.test([...document.querySelectorAll('.toast, [role=status]')].map(e => e.textContent).join(' '))`, 'a "Saved persona" message', 5000);
            await waitFor(`(() => { const s = window.__na.find('select', ${N.persona}); return !!s && [...s.options].some(o => o.textContent.trim() === ${JSON.stringify(NAME)}); })()`, 'the new persona in the select', 5000);
            await type('input', N.name, ''); await type('textarea', N.prompt, '');
            await ev(`(() => { const s = window.__na.find('select', ${N.persona}); const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(NAME)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`window.__na.find('input', ${N.name}).value === ${JSON.stringify(NAME)} && /QA persona/.test(window.__na.find('textarea', ${N.prompt}).value)`, 'the persona fills the name and the prompt', 4000);
        });
        await S.run('the saved persona is still a choice after the dialog is closed and opened again', async () => {
            await ev(`window.hideLaunchModal(); true`); await settle(200);
            await openNewAgent(ev, waitFor); await type('input', N.folder, '/work/payments-app'); await click('button', N.next);
            await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
            assert.ok((await options()).includes(NAME), 'the persona is listed');
        });
        const openMore = async () => { await ev(`(() => { const d = [...window.__na.dialog().querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))).closest('details'); d.open = true; return true; })()`); await settle(100); };
        await S.run('Rename persona and Delete persona are on for a saved persona only (#10285)', async () => {
            await openMore();
            const state = pick => ev(`(() => { const s = window.__na.find('select', ${N.persona}); s.value = ${JSON.stringify(pick)}; s.dispatchEvent(new Event('change', { bubbles: true })); const r = document.getElementById('agent-rename-persona-btn'), d = document.getElementById('agent-delete-persona-btn'); return { rename: !r.disabled, del: !d.disabled, title: r.title }; })()`);
            assert.deepEqual((await state('__blank__')).rename, false, 'off for Blank');
            const builtin = await ev(`(() => { const g = [...window.__na.find('select', ${N.persona}).querySelectorAll('optgroup')].find(x => x.label === 'Built-in'); return g && g.querySelector('option') ? g.querySelector('option').value : null; })()`);
            if (builtin) { const b = await state(builtin); assert.ok(!b.rename && !b.del && /saved personas/i.test(b.title), 'off for a built-in, with the reason: ' + JSON.stringify(b)); }
            const on = await state(NAME); assert.ok(on.rename && on.del, 'on for the saved persona: ' + JSON.stringify(on));
        });
        const NAME2 = NAME + ' renamed';
        await S.run('Rename persona asks for a name and renames it; a taken name is refused (#10285)', async () => {
            await openMore(); await click('button', /^Rename persona$/i);
            await waitFor(`getComputedStyle(document.getElementById('prompt-modal')).display !== 'none'`, 'the rename dialog', 4000);
            assert.equal(await ev(`document.getElementById('prompt-modal-input').value`), NAME, 'it starts from the current name');
            await ev(`(() => { document.getElementById('prompt-modal-input').value = ${JSON.stringify(NAME2)}; document.getElementById('prompt-modal-ok').click(); return true; })()`);
            await waitFor(`(() => { const s = window.__na.find('select', ${N.persona}); return !!s && [...s.options].some(o => o.textContent.trim() === ${JSON.stringify(NAME2)}) && ![...s.options].some(o => o.textContent.trim() === ${JSON.stringify(NAME)}); })()`, 'the renamed persona in the select', 6000);
            assert.match(await toasts(), /Renamed to/, 'a toast says so');
            // a name that is a built-in's is refused
            const builtin = await ev(`(() => { const g = [...window.__na.find('select', ${N.persona}).querySelectorAll('optgroup')].find(x => x.label === 'Built-in'); return g && g.querySelector('option') ? g.querySelector('option').textContent.trim() : null; })()`);
            if (builtin) {
                await openMore(); await click('button', /^Rename persona$/i);
                await waitFor(`getComputedStyle(document.getElementById('prompt-modal')).display !== 'none'`, 'the rename dialog', 4000);
                await ev(`(() => { document.getElementById('prompt-modal-input').value = ${JSON.stringify(builtin)}; document.getElementById('prompt-modal-ok').click(); return true; })()`);
                await waitFor(`/There is already a persona called/.test([...document.querySelectorAll('.toast, [role=status]')].map(e => e.textContent).join(' '))`, 'the refusal', 4000);
                assert.ok(await options().then(o => o.includes(NAME2)), 'the persona keeps its name');
            }
        });
        await S.run('Delete persona asks first, then removes it and goes back to Blank (#10285)', async () => {
            await openMore(); await click('button', /^Delete persona$/i);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the confirm', 4000);
            assert.match(await ev(`document.getElementById('confirm-modal-message').textContent`), new RegExp(NAME2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'it names the persona');
            assert.ok((await options()).includes(NAME2), 'nothing is deleted before the answer');
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`(() => { const s = window.__na.find('select', ${N.persona}); return !!s && ![...s.options].some(o => o.textContent.trim() === ${JSON.stringify(NAME2)}); })()`, 'the persona gone from the select', 6000);
            assert.match(await toasts(), /Deleted persona/, 'a toast says so');
            assert.equal(await ev(`window.__na.find('select', ${N.persona}).value`), '__blank__', 'the choice is Blank again');
            await ev(`[...window.__na.dialog().querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))).closest('details').open = false; true`); // the menu is closed again for the next scenario
        });
        await S.run('the More menu is a disclosure named "More": closed it hides Export and Import, opened (mouse) it shows both', async () => {
            const hidden = await ev(`(() => { const d = window.__na.dialog(); const s = [...d.querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))); if (!s) return null; const det = s.closest('details'); return { open: det.open, exp: !!window.__na.find('button', /^Export personas$/i), imp: !!window.__na.find('button', /^Import personas$/i) }; })()`);
            assert.ok(hidden, 'a summary named More'); assert.equal(hidden.open, false, 'closed at first'); assert.ok(!hidden.exp && !hidden.imp, 'Export and Import are not shown while closed');
            await ev(`[...window.__na.dialog().querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))).click(); true`); await settle(200);
            assert.ok(await ev(`!!window.__na.find('button', /^Export personas$/i) && !!window.__na.find('button', /^Import personas$/i)`), 'Export and Import after opening');
            await ev(`[...window.__na.dialog().querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))).click(); true`); await settle(200);
        });
        await S.run('the More menu by keyboard: Enter on the summary opens it and Escape from inside it does not close the whole dialog before the menu', async () => {
            await ev(`[...window.__na.dialog().querySelectorAll('summary')].find(e => /^more$/i.test(window.__na.name(e))).focus(); true`);
            await key('Enter', 13, '\r');
            assert.ok(await ev(`!!window.__na.find('button', /^Export personas$/i)`), 'Enter opens the menu');
            await key(' ', 32, ' ');
            assert.ok(!(await ev(`!!window.__na.find('button', /^Export personas$/i)`)), 'Space on the summary closes it again (a details element)');
            assert.ok(await ev(`!!window.__na.dialog()`), 'the dialog is still open');
        });
        await restoreAndCheck(); S.finish(); // finish() exits the process, so the setting goes back first
    } finally { await restoreAndCheck().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
