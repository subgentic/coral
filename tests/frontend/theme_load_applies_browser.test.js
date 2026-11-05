// Loading a saved theme in Customize theme puts it in use (#13760, the Operator: "loading a theme, I can't use it without saving it as a new theme"): Load applies the theme to the page now, keeps it as the saved
// theme (a Cancel does not take it back, a reload keeps it) and creates no copy; the list shows the theme in use when the editor opens; an edit that is only previewed is dropped by Cancel; the line above the buttons
// says whether Save and apply updates the theme or makes a new one; Light from the built-ins is kept the same way. 1280 px, isolated dev server; the two themes it makes are deleted and the settings put back.
'use strict';
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const fs = require('node:fs');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    const failures = [], S = `(window.__coralStatic || '/static/')`, A = 'zz-load-a-' + Date.now().toString(36), B = 'zz-load-b-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const count = async () => ((await api('GET', '/api/themes')).body.themes || []).length;
    const load = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); };
    const colour = v => ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(v)}).trim().toLowerCase()`);
    const open = async () => { await ev(`window.showThemeConfigurator(); true`); await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'flex' && !!document.querySelector('#theme-configurator-modal .theme-color-text')`, 'the editor', 8000); };
    const pick = async name => { await ev(`(() => { const s = document.getElementById('theme-load-select'); s.value = ${JSON.stringify(name)}; document.querySelector('[data-on-click="theme-load"]').click(); return true; })()`); };
    const close = async () => { await ev(`document.querySelector('[data-on-click="theme-close"]').click(); true`); await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'none'`, 'it closes', 4000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await load();
        const VAR = await ev(`fetch('/api/themes/variables').then(r => r.json()).then(j => Object.keys(Object.values(j.groups)[0])[0])`);
        await api('PUT', `/api/settings`, { custom_theme: '', theme: 'dark' });
        for (const [n, c] of [[A, '#ff00aa'], [B, '#00aa44']]) check((await api('PUT', `/api/themes/${n}`, { description: 'x', base: 'dark', variables: { [VAR]: c } })).status === 200, 'the theme ' + n + ' is saved');
        const n0 = await count();
        await load(); await ev(`import(${S} + 'settings_core.js').then(sc => { sc.clearCustomThemeVars(); sc.applyTheme('dark', { remember: false }); return true; })`);
        check(await colour(VAR) !== '#ff00aa', 'before Load the page is not that theme');
        await open();
        const shown0 = await ev(`document.getElementById('theme-load-select').value`);
        check(/^(base:dark|dark)$/i.test(shown0), 'with no saved theme the list shows the page base (Dark): ' + shown0);
        await pick(A);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(VAR)}).trim().toLowerCase() === '#ff00aa'`, 'Load applies the theme to the page now', 6000).catch(() => {});
        check(await colour(VAR) === '#ff00aa', 'Load puts the theme on the page now: ' + await colour(VAR));
        check(await ev(`document.getElementById('theme-load-select').value`) === A, 'the list keeps showing the loaded theme');
        const hint = await ev(`(document.getElementById('theme-save-hint') || {}).textContent || ''`);
        check(new RegExp(`updates "${A}"`).test(hint) && /new copy/.test(hint), 'the line above the buttons says Save and apply updates it: ' + hint);
        const st = (await api('GET', '/api/settings')).body;
        check((st.settings || st).custom_theme === A, 'it is the saved theme setting');
        await shot('theme-loaded-1280');
        await close();
        check(await colour(VAR) === '#ff00aa', 'Cancel does not take a loaded theme back: ' + await colour(VAR));
        check(await count() === n0, 'no new theme was made');
        await load();
        check(await colour(VAR) === '#ff00aa', 'after a reload the loaded theme is still the theme: ' + await colour(VAR));
        await open();
        check(await ev(`document.getElementById('theme-load-select').value`) === A, 'the reopened editor shows the theme in use');
        await pick(B); await waitFor(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(VAR)}).trim().toLowerCase() === '#00aa44'`, 'B is applied', 6000).catch(() => {});
        // an edit that is only previewed is dropped by Cancel, back to the loaded theme
        await ev(`(() => { const t = document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${VAR}"]'); t.value = '#123456'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-on-click="theme-preview"]').click(); return true; })()`);
        check(await colour(VAR) === '#123456', 'Preview shows the edit');
        await close();
        check(await colour(VAR) === '#00aa44', 'Cancel drops the edit and keeps the loaded theme: ' + await colour(VAR));
        // a new name: the line says it makes a new theme
        await open();
        await ev(`(() => { const n = document.getElementById('theme-save-name'); n.value = 'a brand new one'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        check(/makes a new theme/.test(await ev(`(document.getElementById('theme-save-hint') || {}).textContent || ''`)), 'a new name says it makes a new theme');
        await close();
        // the theme is read once (no second GET that could fail after the settings saved), and a settings save that fails keeps nothing
        await ev(`(() => { window.__gets = []; window.__failPut = false; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = String(u), m = String((o && o.method) || 'GET').toUpperCase(); if (m === 'GET' && url.startsWith('/api/themes/') && !url.includes('variables')) window.__gets.push(decodeURIComponent(url)); if (m === 'PUT' && url === '/api/settings' && window.__failPut) return Promise.resolve(new Response('{"error":"no"}', { status: 500, headers: { 'Content-Type': 'application/json' } })); return R(u, o); }; return true; })()`);
        await open(); await pick(A);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(VAR)}).trim().toLowerCase() === '#ff00aa'`, 'A again', 6000).catch(() => {});
        check((await ev(`window.__gets.filter(g => g.endsWith('/' + ${JSON.stringify(A)}))`)).length === 1, 'Load reads the theme once: ' + JSON.stringify(await ev(`window.__gets`)));
        const prefBefore = await ev(`localStorage.getItem('coral-theme')`);
        await ev(`(() => { const t = document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${VAR}"]'); t.value = '#777777'; t.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('theme-save-desc'); d.value = 'my draft'; return true; })()`);
        const fields = () => ev(`({ name: document.getElementById('theme-save-name').value, desc: document.getElementById('theme-save-desc').value, base: document.getElementById('theme-save-base').value, colour: document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${VAR}"]').value, list: document.getElementById('theme-load-select').value })`);
        const draft = await fields();
        await ev(`document.querySelectorAll('#toast-host > *, .toast').forEach(e => e.remove()); window.__failPut = true; true`); await pick(B); await new Promise(r => setTimeout(r, 700)); // sleep-ok: the refused save answers and the page goes back
        await ev(`window.__failPut = false; true`);
        check(await colour(VAR) === '#ff00aa', 'a settings save that fails keeps nothing: the page is still A: ' + await colour(VAR));
        check(await ev(`document.getElementById('theme-load-select').value`) === A, 'and the list still shows A');
        check(await ev(`localStorage.getItem('coral-theme')`) === prefBefore, 'and the remembered theme preference is as it was');
        const toasts = await ev(`[...document.querySelectorAll('.toast')].map(e => e.textContent.trim())`);
        check(toasts.some(t => /Could not use that theme/.test(t)) && !toasts.some(t => /Using theme: zz-load-b/.test(t)), 'the refusal is said and there is no "Using theme" toast for B: ' + JSON.stringify(toasts));
        const afterFail = await fields();
        check(JSON.stringify(afterFail) === JSON.stringify(draft), 'a refused Load leaves every field of the editor as it was, the unsaved draft too: ' + JSON.stringify([draft, afterFail]));
        // Save and apply now still targets A, with the draft: B is not overwritten
        await ev(`document.querySelector('[data-on-click="theme-save"]').click(); true`);
        await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'none'`, 'Save and apply closes it', 8000).catch(() => {});
        const savedA = (await api('GET', `/api/themes/${A}`)).body.theme || {}, savedB = (await api('GET', `/api/themes/${B}`)).body.theme || {};
        check((savedA.variables || {})[VAR] === '#777777' && savedA.description === 'my draft', 'Save went to A, with the draft: ' + JSON.stringify([(savedA.variables || {})[VAR], savedA.description]));
        check((savedB.variables || {})[VAR] === '#00aa44', 'and B was not touched: ' + (savedB.variables || {})[VAR]);
        // a partial theme (it names one colour): loaded from the other base, every other colour is its base's, in the editor and on the page; Preview changes nothing; one edit keeps the rest
        const P = 'zz-load-p-' + Date.now().toString(36);
        check((await api('PUT', `/api/themes/${P}`, { description: 'partial', base: 'light', variables: { [VAR]: '#112233' } })).status === 200, 'a partial light theme is saved');
        const n1 = await count();
        await open();
        const V2 = await ev(`[...document.querySelectorAll('#theme-configurator-modal .theme-color-text')].map(t => t.dataset.var).find(v => v !== ${JSON.stringify(VAR)} && /bg/.test(v)) || [...document.querySelectorAll('#theme-configurator-modal .theme-color-text')].map(t => t.dataset.var)[3]`);
        const editor = v => ev(`(document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${v}"]') || {}).value.trim().toLowerCase()`);
        const darkV2 = await colour(V2);
        await pick(P); await waitFor(`document.documentElement.getAttribute('data-theme') === 'light'`, 'the partial light theme is applied', 6000).catch(() => {});
        const lightV2 = await colour(V2);
        check(lightV2 !== darkV2, 'the other colour changed with the base: ' + darkV2 + ' -> ' + lightV2);
        check(await editor(V2) === lightV2 && await editor(VAR) === '#112233', 'the editor shows what the page shows (the base\'s colour and the theme\'s own), not the dark edits: ' + await editor(V2) + ' vs ' + lightV2);
        await ev(`document.querySelector('[data-on-click="theme-preview"]').click(); true`);
        check(await colour(V2) === lightV2 && await colour(VAR) === '#112233' && await ev(`document.documentElement.getAttribute('data-theme')`) === 'light', 'Preview changes nothing');
        await ev(`(() => { const t = document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${VAR}"]'); t.value = '#445566'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-on-click="theme-save"]').click(); return true; })()`);
        await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'none'`, 'Save and apply closes it', 8000).catch(() => {});
        const savedP = (await api('GET', `/api/themes/${P}`)).body.theme || {};
        check(savedP.variables && savedP.variables[VAR].toLowerCase() === '#445566' && String(savedP.variables[V2] || '').toLowerCase() === lightV2 && savedP.base === 'light', 'Save and apply (the same name) updated it: the edit kept, the base\'s other colours kept: ' + JSON.stringify([savedP.base, (savedP.variables || {})[VAR], (savedP.variables || {})[V2]]));
        check(await count() === n1, 'and made no copy');
        // a new name makes a copy
        await open();
        await ev(`(() => { const n = document.getElementById('theme-save-name'); n.value = ${JSON.stringify(P + '-copy')}; n.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-on-click="theme-save"]').click(); return true; })()`);
        await waitFor(`document.getElementById('theme-configurator-modal').style.display === 'none'`, 'the copy is saved', 8000).catch(() => {});
        check(await count() === n1 + 1, 'a new name made one new theme');
        check(((await api('GET', '/api/settings')).body.settings || (await api('GET', '/api/settings')).body).custom_theme === P + '-copy', 'and it is the theme in use');
        await api('DELETE', `/api/themes/${P}-copy`);
        // an imported theme is stored once and put in use
        const I = 'zz-load-i-' + Date.now().toString(36);
        await open();
        await ev(`(() => { const proto = HTMLInputElement.prototype, orig = proto.click; proto.click = function () { if (this.type === 'file' && this.onchange) { const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ name: ${JSON.stringify(I)}, description: 'imp', base: 'dark', variables: { [${JSON.stringify(VAR)}]: '#fa8072' } })], ${JSON.stringify(I)} + '.json', { type: 'application/json' })); Object.defineProperty(this, 'files', { value: dt.files }); this.onchange(); return; } return orig.call(this); }; return true; })()`);
        const n2 = await count();
        await ev(`document.querySelector('[data-on-click="theme-import"]').click(); true`);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(VAR)}).trim().toLowerCase() === '#fa8072'`, 'the imported theme is applied', 8000).catch(() => {});
        check(await colour(VAR) === '#fa8072', 'an imported theme is put in use: ' + await colour(VAR));
        check(await count() === n2 + 1, 'stored once');
        check(await ev(`document.getElementById('theme-load-select').value`) === I, 'and the list shows it');
        // an import whose save is refused: stored and listed, not in use, and the editor (with an unsaved draft) as it was
        const J = 'zz-load-j-' + Date.now().toString(36);
        await ev(`(() => { document.getElementById('theme-save-name').value = 'my draft name'; const proto = HTMLInputElement.prototype, orig = proto.click; proto.click = function () { if (this.type === 'file' && this.onchange) { const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ name: ${JSON.stringify(J)}, description: 'imp2', base: 'light', variables: { [${JSON.stringify(VAR)}]: '#010203' } })], ${JSON.stringify(J)} + '.json', { type: 'application/json' })); Object.defineProperty(this, 'files', { value: dt.files }); this.onchange(); return; } return orig.call(this); }; window.__failPut = true; return true; })()`);
        const beforeImp = await fields();
        await ev(`document.querySelector('[data-on-click="theme-import"]').click(); true`); await new Promise(r => setTimeout(r, 900)); // sleep-ok: the import, the refused save and the rollback answer in turn
        await ev(`window.__failPut = false; true`);
        const afterImp = await fields();
        check(JSON.stringify(afterImp) === JSON.stringify(beforeImp) && await colour(VAR) === '#fa8072', 'a refused import leaves the editor and the page as they were: ' + JSON.stringify([beforeImp, afterImp]));
        check(await ev(`[...document.querySelectorAll('#theme-load-select option')].some(o => o.value === ${JSON.stringify(J)})`), 'the imported theme (stored) is in the list');
        await api('DELETE', `/api/themes/${J}`);
        // a generated theme stays a preview: nothing applied, nothing stored, the line says Save and apply makes a new theme
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => String(u) === '/api/themes/generate' ? Promise.resolve(new Response(JSON.stringify({ name: 'gen one', variables: { [${JSON.stringify(VAR)}]: '#abcdef' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o); const p = document.getElementById('theme-ai-prompt'); p.value = 'pink'; return true; })()`);
        await ev(`document.querySelector('[data-on-click="theme-generate"]').click(); true`);
        await waitFor(`(document.querySelector('#theme-configurator-modal .theme-color-text[data-var="${VAR}"]') || {}).value === '#abcdef'`, 'the generated colour is in the editor', 8000).catch(() => {});
        check(await colour(VAR) === '#fa8072', 'a generated theme is not applied until Preview: ' + await colour(VAR));
        check(await count() === n2 + 1, 'and is not stored');
        check(/makes a new theme, "gen one"/.test(await ev(`document.getElementById('theme-save-hint').textContent`)), 'the line says Save and apply makes a new theme');
        await close();
        for (const n of [P, I]) await api('DELETE', `/api/themes/${n}`).catch(() => {});
        // Light from the built-ins is kept as well
        await open(); await pick('base:light');
        await waitFor(`document.documentElement.getAttribute('data-theme') === 'light'`, 'Light is applied', 6000).catch(() => {});
        await close(); await load();
        check(await ev(`document.documentElement.getAttribute('data-theme')`) === 'light', 'Load Light is still Light after a reload');
        check(await count() === n0, 'and the themes made here are all gone again');
    } finally {
        for (const n of [A, B]) await api('DELETE', `/api/themes/${n}`).catch(() => {});
        await guard.restore(); await client.close();
    }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS Load puts a saved theme in use: now, after Cancel and after a reload, with no copy');
})().catch(e => { console.error(e); process.exit(1); });
