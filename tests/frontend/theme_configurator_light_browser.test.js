// The Themes configurator can make a light theme (#12113, Beta #12082): Light is a built-in preset in Load beside Dark, the Based on list starts on the page's own base, choosing Light there gives every colour
// the person has not edited the Light value (it kept the dark page's colours, so "Based on: Light" saved a dark theme), a colour they edited stays, and a theme saved Based on Light is a light page when it is applied
// again (page load). 1280 px, the isolated dev server; the theme it saves is deleted.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], S = `(window.__coralStatic || '/static/')`, NAME = 'zz-light-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = () => ev(`window.showThemeConfigurator(); true`); // the entry point a person's click reaches
    const val = v => ev(`(document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${v}"]') || {}).value || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`import(${S} + 'settings_core.js').then(sc => { sc.clearCustomThemeVars(); sc.applyTheme('dark', { remember: false }); return true; })`);
        await open(); await waitFor(`!!document.querySelector('#theme-configurator-modal .theme-color-text')`, 'the editor', 8000);
        const bgVar = await ev(`document.querySelector('#theme-configurator-modal .theme-color-text').dataset.var`);
        const darkBg = await val(bgVar);
        const opts = await ev(`[...document.querySelectorAll('#theme-load-select option')].map(o => o.textContent.trim())`);
        check(opts.includes('Dark') && opts.includes('Light'), 'Load lists the built-in Dark and Light: ' + JSON.stringify(opts));
        check(await ev(`document.getElementById('theme-save-base').value`) === 'dark', 'on a dark page Based on starts on Dark');
        // Based on: Light gives the untouched colours the Light values
        await ev(`(() => { const s = document.getElementById('theme-save-base'); s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${bgVar}"]').value !== ${JSON.stringify(darkBg)}`, 'the colours take the Light values', 6000).catch(() => {});
        const lightBg = await val(bgVar);
        check(lightBg && lightBg !== darkBg, `choosing Light changes the colours the person did not edit: ${darkBg} -> ${lightBg}`);
        check(await ev(`document.getElementById('theme-save-base').value`) === 'light', 'and the list stays on Light');
        await shot('configurator-light-base');
        // an edited colour stays when the base changes back
        const otherVar = await ev(`[...document.querySelectorAll('#theme-configurator-modal .theme-color-text')][3].dataset.var`);
        await ev(`(() => { const t = document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${otherVar}"]'); t.value = '#123456'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await ev(`(() => { const s = document.getElementById('theme-save-base'); s.value = 'dark'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${bgVar}"]').value === ${JSON.stringify(darkBg)}`, 'back to the Dark values', 6000).catch(() => {});
        check(await val(bgVar) === darkBg && (await val(otherVar)).toLowerCase() === '#123456', `back on Dark the untouched colours are Dark's and the edited one stays: ${await val(bgVar)} ${await val(otherVar)}`);
        // Light in Load, then Save & Apply: a light theme on the server and on the page
        await ev(`(() => { const s = document.getElementById('theme-load-select'); s.value = 'base:light'; document.querySelector('[data-on-click="theme-load"]').click(); return true; })()`);
        await waitFor(`document.getElementById('theme-save-base').value === 'light'`, 'Light loaded', 6000).catch(() => {});
        check(await val(bgVar) === lightBg, `Load > Light fills the Light colours: ${await val(bgVar)} vs ${lightBg}`);
        await ev(`document.getElementById('theme-save-name').value = ${JSON.stringify(NAME)}; document.querySelector('[data-on-click="theme-save"]').click(); true`);
        await waitFor(`document.documentElement.getAttribute('data-theme') === 'light'`, 'the page is light after Save & Apply', 8000).catch(() => {});
        const saved = await ev(`fetch('/api/themes/${NAME}').then(r => r.json()).then(d => ({ base: d.theme && d.theme.base, bg: d.theme && d.theme.variables && d.theme.variables[${JSON.stringify(bgVar)}] }))`);
        check(saved.base === 'light' && saved.bg && saved.bg.toLowerCase() === lightBg.toLowerCase(), 'the saved theme is Based on Light with the Light colours: ' + JSON.stringify({ saved, lightBg }));
        check(await ev(`document.documentElement.getAttribute('data-theme')`) === 'light', 'the page is on the light base after Save & Apply');
        // applied again at page load: still light
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`import(${S} + 'settings_core.js').then(sc => sc.applyCustomThemeByName(${JSON.stringify(NAME)}, { remember: false })).then(() => true)`); await ev(framesJs(4));
        check(await ev(`document.documentElement.getAttribute('data-theme')`) === 'light', 'the saved theme applied again is a light page');
        const bgNow = await ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(bgVar)}).trim()`);
        check(bgNow.toLowerCase() === lightBg.toLowerCase(), `and its background is the Light one: ${bgNow} vs ${lightBg}`);
    } finally {
        await ev(`fetch('/api/themes/${NAME}', { method: 'DELETE' }).then(() => fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ custom_theme: '' }) })).then(() => true)`).catch(() => {});
        await client.close();
    }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('theme_configurator_light_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
