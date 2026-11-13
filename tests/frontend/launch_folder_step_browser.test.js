// New agent's folder step (#15891, LA7): an error is said once, under its field, not again above the buttons; the folder list's rows are 32 px high with the icon set's folder, not an emoji;
// and while the list is open "Use this folder" is the one Primary (Next is the Default look), so one blue button shows at any time.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1440, 900], [390, 800]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes('/api/filesystem/list') ? Promise.resolve(new Response(JSON.stringify({ path: '/work', entries: ['alpha', 'beta', 'gamma'] }), { status: 200, headers: { 'content-type': 'application/json' } })) : real(u, o); })(); window.showLaunchModal(); window._selectLaunchType('agent'); true`);
            await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step');
            const visibleText = txt => `[...document.querySelectorAll('#launch-modal *')].filter(e => e.children.length === 0 && e.getClientRects().length && e.textContent.includes(${JSON.stringify(txt)})).length`;
            console.log(`${w}: a missing folder is said once, under the field`);
            await ev(`document.getElementById('launch-dir').value = ''; document.getElementById('launch-agent-go').click(); true`);
            await waitFor(`${visibleText('Choose a folder')} >= 1`, 'the error under the field');
            assert.equal(await ev(visibleText('Choose a folder')), 1, `${w}: "Choose a folder" shows once`);
            assert.equal(await ev(`!!document.getElementById('launch-agent-status')`), false, `${w}: no second line above the buttons`);
            console.log(`${w}: one blue button, with the list closed and open; the list's rows are 32 px with the icon set's folder`);
            const blue = () => ev(`[...document.querySelectorAll('#launch-modal .btn-primary')].filter(b => b.getClientRects().length && getComputedStyle(b).backgroundColor === getComputedStyle(document.querySelector('#launch-modal .dir-browser-use') || b).backgroundColor).map(b => b.id || b.className)`);
            { const b = await blue(); assert.deepEqual(b, ['launch-agent-go'], `${w}: Launch is the one Primary, saw ${JSON.stringify(b)}`); }
            await ev(`document.getElementById('btn-browse').click(); true`);
            await waitFor(`document.querySelectorAll('#browser-list li:not(.empty-state)').length > 0`, 'the folder rows');
            await waitFor(`[...document.querySelectorAll('#browser-list li:not(.empty-state)')].every(li => Math.round(li.getBoundingClientRect().height) === 32)`, 'the list rows at 32 px (their lazy sheet loaded with the list)').catch(() => {});
            const rows = await ev(`[...document.querySelectorAll('#browser-list li:not(.empty-state)')].map(li => ({ h: Math.round(li.getBoundingClientRect().height), icon: li.querySelector('.dir-icon').textContent.trim(), cls: li.querySelector('.dir-icon').className }))`);
            assert.ok(rows.every(r => r.h === 32), `${w}: folder rows are 32 px, saw ${JSON.stringify([...new Set(rows.map(r => r.h))])}`);
            assert.ok(rows.every(r => r.icon === 'folder' && /material-icons/.test(r.cls)), `${w}: the folder icon is the icon set's, not an emoji: ${JSON.stringify(rows[0])}`);
            await waitFor(`getComputedStyle(document.getElementById('launch-agent-go')).backgroundColor === getComputedStyle(document.getElementById('launch-agent-cancel')).backgroundColor`, 'Launch in the Default look (its 0.15 s fade done)');
            const open = await ev(`({ use: getComputedStyle(document.querySelector('#launch-modal .dir-browser-use')).backgroundColor, next: getComputedStyle(document.getElementById('launch-agent-go')).backgroundColor, def: getComputedStyle(document.getElementById('launch-agent-cancel')).backgroundColor })`);
            open.attrs = await ev(`[...document.querySelectorAll('#launch-modal .dir-browser')].map(b => b.id + ':' + b.getAttribute('style'))`); assert.notEqual(open.use, open.next, `${w}: while the list is open Launch is not the blue one ${JSON.stringify(open)}`);
            assert.equal(open.next, open.def, `${w}: Launch wears the Default look while the list is open`);
            await ev(`document.querySelector('#launch-modal .dir-browser-use').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('dir-browser')).display === 'none'`, 'the list closed');
            await waitFor(`getComputedStyle(document.getElementById('launch-agent-go')).backgroundColor !== getComputedStyle(document.getElementById('launch-agent-cancel')).backgroundColor`, `${w}: Launch is the Primary again once the list is closed`);
        }
        console.log('The Open folder list gets the 32 px rows with no New agent opened first (#15891)');
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes('/api/filesystem/list') ? Promise.resolve(new Response(JSON.stringify({ path: '/work', entries: ['alpha', 'beta'] }), { status: 200, headers: { 'content-type': 'application/json' } })) : real(u, o); })(); window.showOpenFolderModal(); window.toggleBrowser('open-folder-dir', 'open-folder-browser', 'open-folder-browser-list', 'open-folder-browser-path'); true`);
        await waitFor(`document.querySelectorAll('#open-folder-browser-list li:not(.empty-state)').length > 0`, 'the Open folder rows');
        await waitFor(`[...document.querySelectorAll('#open-folder-browser-list li:not(.empty-state)')].every(li => Math.round(li.getBoundingClientRect().height) === 32)`, 'the Open folder rows are 32 px: ' + await ev(`JSON.stringify({ h: [...document.querySelectorAll('#open-folder-browser-list li')].map(li => li.getBoundingClientRect().height), sheets: [...document.styleSheets].map(x => x.href).filter(h => /launch_folder/.test(h || '')), links: [...document.querySelectorAll('link')].map(l => l.href).filter(h => /folder/.test(h)) })`));
        console.log('PASS launch folder step');
    } finally {
        await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
