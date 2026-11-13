// Custom permission modes save on Add, Update and Remove (#16345, beta walk #16344): Settings has no Apply button, so a mode kept as a draft was lost on Close or reload.
// Against the real server: add a mode and reload, it is there; edit it and reload, the edit is there; remove it and reload, it is gone; the status never says "Apply to save"; a refused save says
// "Not saved. <the server's reason> Try again.", puts the list back to what the server has and leaves nothing to lose; closing Settings with the mode added keeps it. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings();
    const list = () => ev(`fetch('/api/custom-modes').then(r => r.json()).then(d => d.modes.map(m => [m.name, m.flags.join(' ')]))`);
    const clear = () => ev(`fetch('/api/custom-modes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"modes":[]}' }).then(r => r.status)`);
    const load = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); };
    const openSettings = async () => { await ev(`window.showSettingsModal('agents'); true`); await waitFor(`!!document.querySelector('#settings-custom-modes [data-cpm-add]')`, 'the custom modes block', 8000); };
    const rows = () => ev(`[...document.querySelectorAll('#settings-custom-modes .cm-row[data-type]')].map(r => r.querySelector('.cm-name').textContent)`);
    const status = () => ev(`document.querySelector('#settings-custom-modes .cm-status').textContent`);
    const fill = (name, flags) => ev(`(() => { document.getElementById('cpm-name').value = ${JSON.stringify(name)}; document.getElementById('cpm-flags').value = ${JSON.stringify(flags)}; document.querySelector('#settings-custom-modes .cm-form .sv-save').click(); return true; })()`);
    const add = async (name, flags) => { await ev(`document.querySelector('#settings-custom-modes [data-cpm-add]').click(); true`); await waitFor(`!!document.getElementById('cpm-name')`, 'the form'); await fill(name, flags); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            const at = `${w}: `;
            await load(); await clear(); await load(); await openSettings();

            // add: saved at once, said so, no Apply to wait for, and still there after a reload
            await add('Plan only', '--permission-mode\nplan');
            await waitFor(`document.querySelectorAll('#settings-custom-modes .cm-row[data-type]').length === 1 && !document.querySelector('#settings-custom-modes .cm-form')`, 'the row');
            assert.deepEqual(await list(), [['Plan only', '--permission-mode plan']], at + 'Add saved the mode on the server');
            assert.match(await status(), /^Saved$/, at + 'it says Saved');
            assert.doesNotMatch(await status(), /Apply|Unsaved/, at + 'nothing says Apply');
            await load(); await openSettings();
            assert.deepEqual(await rows(), ['Plan only'], at + 'after a reload the mode is there');

            // edit: the change is saved at once
            await ev(`document.querySelector('#settings-custom-modes [data-cpm-edit="0"]').click(); true`);
            await waitFor(`!!document.getElementById('cpm-name')`, 'the edit form');
            await fill('Plan, renamed', '--permission-mode\nplan');
            await waitFor(`[...document.querySelectorAll('#settings-custom-modes .cm-name')].some(e => e.textContent === 'Plan, renamed')`, 'the renamed row');
            assert.deepEqual(await list(), [['Plan, renamed', '--permission-mode plan']], at + 'Update saved the change on the server');
            await load(); await openSettings();
            assert.deepEqual(await rows(), ['Plan, renamed'], at + 'after a reload the edit is there');

            // close Settings with nothing pending: the mode is still there
            await ev(`window.hideSettingsModal(); true`);
            await load(); await openSettings();
            assert.deepEqual(await rows(), ['Plan, renamed'], at + 'closing Settings did not lose it');

            // a refused save: the server's reason, the list back to what the server has
            await ev(`(() => { const f = window.fetch; window.__putRefused = true; window.fetch = (u, o) => String(u).includes('/api/custom-modes') && o && o.method === 'PUT' && window.__putRefused ? Promise.resolve(new Response(JSON.stringify({ error: 'That mode is refused today.' }), { status: 400, headers: { 'content-type': 'application/json' } })) : f(u, o); return true; })()`);
            await add('Second', '--permission-mode\nplan');
            await waitFor(`/Not saved/.test(document.querySelector('#settings-custom-modes .cm-status').textContent)`, 'the refusal said');
            assert.equal(await status(), 'Not saved. That mode is refused today. Try again.', at + 'the server\'s reason is said');
            assert.deepEqual(await rows(), ['Plan, renamed'], at + 'the refused mode is not left in the list');
            assert.deepEqual(await list(), [['Plan, renamed', '--permission-mode plan']], at + 'and the server still has only the saved one');
            await ev(`window.__putRefused = false; true`);

            // remove: saved at once, gone after a reload
            await ev(`document.querySelector('#settings-custom-modes .cm-row[data-type] button[aria-label^="Remove"]').click(); true`);
            await waitFor(`document.querySelectorAll('#settings-custom-modes .cm-row[data-type]').length === 0`, 'the row removed');
            await waitFor(`fetch('/api/custom-modes').then(r => r.json()).then(d => d.modes.length === 0)`, 'Remove saved on the server');
            await load(); await openSettings();
            assert.deepEqual(await rows(), [], at + 'after a reload the removed mode is gone');
            console.log('PASS ' + w + ': add, edit and remove survive a reload; a refused save says why');
        }
    } finally {
        await clear().catch(() => {});
        await guard.restore().catch(() => {});
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
