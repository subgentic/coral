// Customize theme's buttons (#15845, design D2, guidelines 4.8): one Primary (Save and apply); Generate is a Default button; Delete is Quiet, alone at the far left of the footer, grey until it is pointed at; Import, Export, Reset and Preview
// are the items of one More menu, and each still does what it did (the action names the old buttons carried). 1280 px and 390 px, dark and light, the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) for (const theme of ['dark', 'light']) {
            const at = `${w} px ${theme}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(sc => { sc.clearCustomThemeVars(); sc.applyTheme('${theme}', { remember: false }); return true; })`);
            await ev(`window.showThemeConfigurator(); true`);
            await waitFor(`!!document.querySelector('#theme-configurator-modal .modal-actions') && !!document.getElementById('theme-more')`, at + 'the dialog', 8000);
            const m = await ev(`(() => { const d = document.getElementById('theme-configurator-modal'); const f = d.querySelector('.modal-actions'); const del = f.querySelector('[data-on-click="theme-delete"]'); const gen = document.getElementById('theme-generate-btn');
                const items = [...d.querySelectorAll('#theme-more-menu .menu-item')].map(b => b.textContent.trim()); const acts = [...d.querySelectorAll('#theme-more-menu .menu-item')].map(b => b.getAttribute('data-on-click'));
                const r = x => x.getBoundingClientRect(), fr = r(f), dr = r(del), cancel = f.querySelector('[data-on-click="theme-close"]'), save = f.querySelector('[data-on-click="theme-save"]');
                return { primaries: [...d.querySelectorAll('.btn-primary')].map(b => b.textContent.trim()), genPrimary: gen ? gen.classList.contains('btn-primary') : null, footer: [...f.querySelectorAll('button')].map(b => b.textContent.trim()), delQuiet: del.classList.contains('btn-quiet'), delLeft: Math.round(dr.left - fr.left) <= 2, cancelRight: r(cancel).left > dr.right, saveLast: Math.round(fr.right - r(save).right) <= 2, delColor: getComputedStyle(del).color, delDisabled: del.disabled, delBorder: getComputedStyle(del).borderTopColor, items, acts, old: [...d.querySelectorAll('.theme-toolbar > .btn, .theme-toolbar button.btn')].map(b => b.textContent.trim()) }; })()`);
            assert.deepEqual(m.primaries, ['Save and apply'], at + 'one blue button: ' + JSON.stringify(m.primaries));
            assert.equal(m.genPrimary === true, false, at + 'Generate is a Default button');
            assert.deepEqual(m.footer, ['Delete', 'Cancel', 'Save and apply'], at + 'the footer: Delete, Cancel, the Primary');
            assert.ok(m.delQuiet && m.delLeft && m.cancelRight && m.saveLast, at + 'Delete alone at the far left, the Primary at the far right: ' + JSON.stringify(m));
            assert.deepEqual(m.items, ['Import', 'Export', 'Reset', 'Preview'], at + 'the More menu holds the other four');
            assert.deepEqual(m.acts, ['theme-import', 'theme-export', 'theme-reset', 'theme-preview'], at + 'each item runs the old action');
            await shot(`theme-${w}-px-${theme}`); // at rest, the menu shut
            const rest = m.delColor;
            await ev(`document.querySelector('#theme-configurator-modal [data-on-click="theme-delete"]').matches(':hover'); true`);
            const box = await ev(`(() => { const b = document.querySelector('#theme-configurator-modal [data-on-click="theme-delete"]').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
            await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
            const err = await ev(`(() => { const p = document.createElement('i'); p.style.color = getComputedStyle(document.documentElement).getPropertyValue('--error-text'); document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
            assert.notEqual(rest, err, at + 'Delete is not red at rest: ' + rest);
            const bg = await ev(`getComputedStyle(document.querySelector('#theme-configurator-modal [data-on-click="theme-delete"]')).backgroundColor`); assert.match(bg, /rgba\(0, 0, 0, 0\)|transparent/, at + 'Delete has no box at rest: ' + bg + ' ' + rest);
            await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: box.x, y: box.y });
            await waitFor(`getComputedStyle(document.querySelector('#theme-configurator-modal [data-on-click="theme-delete"]')).color === ${JSON.stringify(err)}`, at + 'Delete turns red when pointed at', 3000);
            await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
            // the menu opens and shows its four items
            await ev(`document.getElementById('theme-more').click(); true`);
            await waitFor(`!document.getElementById('theme-more-menu').hidden && document.getElementById('theme-more-menu').getBoundingClientRect().height > 0`, at + 'the More menu opens', 4000);
            assert.equal(await ev(`(() => { const m = document.getElementById('theme-more-menu').getBoundingClientRect(), c = document.querySelector('#theme-configurator-modal .modal-content').getBoundingClientRect(); return m.left >= c.left - 1 && m.right <= c.right + 1 && m.bottom <= c.bottom + 1; })()`), true, at + 'the menu is inside the dialog, not cut');
            await shot(`theme-${w}-px-${theme}-more`); // the menu open
            await ev(`document.getElementById('theme-more').click(); true`);
        }
        console.log('PASS Customize theme buttons');
    } finally { await client.close(); await guard.restore(); }
})().catch(e => { console.error(e); process.exit(1); });
