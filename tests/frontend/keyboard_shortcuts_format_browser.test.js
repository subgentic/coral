// The Keyboard shortcuts dialog is a list, not a block of text (#11246, the Operator: "the keyboard shortcut should be a different color than the descriptive text"): each row is a <dt> of <kbd> chips (the
// Mac glyphs ⌘ ⌥ ⇧ ⌃ on a Mac, the words elsewhere) beside a <dd> of its description, in four groups under headings, with a close button in its header. The keys and the description are different colours, both hold 4.5:1 in
// the light and dark themes, and a description that wraps stays in its own column (never under the keys), at 1440 px and at 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const GROUPS = ['Navigation', 'Chat', 'Search', 'Dialogs'];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const { settle } = require('./helpers/wait').bind(ev);
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    // The page's own theme key, set before the page loads; a Mac or another computer, by what the page asks the browser (navigator.userAgentData first, then platform).
    const load = async (w, theme, mac) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
        await Page.navigate({ url: 'about:blank' });
        await ev(`try { localStorage.setItem('coral-theme', ${JSON.stringify(theme)}); } catch (e) {} true`).catch(() => {});
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`try { localStorage.setItem('coral-theme', ${JSON.stringify(theme)}); } catch (e) {} document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
        await ev(`Object.defineProperty(navigator, 'platform', { configurable: true, get: () => ${JSON.stringify(mac ? 'MacIntel' : 'Win32')} }); Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => ({ platform: ${JSON.stringify(mac ? 'macOS' : 'Windows')} }) }); document.activeElement && document.activeElement.blur(); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'shortcuts.js').then(m => m.showShortcuts()).then(() => true)`); await settle(400);
    };
    // One pass over the open dialog, in the page: what it holds and how it is laid out.
    const READ = `(() => {
        const m = document.getElementById('shortcuts-modal');
        if (!m || getComputedStyle(m).display === 'none') return { open: false };
        const rgba = c => { const x = document.createElement('canvas').getContext('2d'); x.clearRect(0, 0, 1, 1); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const sat = c => { const [r, g, b] = rgba(c).slice(0, 3).map(v => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };
        const bgOf = e => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let base = [255, 255, 255]; for (let i = layers.length - 1; i >= 0; i--) { const [r, g, b, a] = layers[i]; base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]; } return base; };
        const ratio = e => { const fg = rgba(getComputedStyle(e).color), bg = bgOf(e); const f = [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])); const a = lum(f), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
        const box = e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        const headings = [...m.querySelectorAll('h4')].map(h => h.textContent.trim());
        const groups = [...m.querySelectorAll('dl')].length;
        const rows = [...m.querySelectorAll('dl > div')].map(row => {
            const dt = row.querySelector('dt'), dd = row.querySelector('dd');
            const kbds = dt ? [...dt.querySelectorAll('kbd')] : [];
            const lines = []; if (dd) { const rg = document.createRange(); rg.selectNodeContents(dd); for (const r of rg.getClientRects()) lines.push(r.left); }
            const kb = dt ? box(dt) : null, db = dd ? box(dd) : null;
            return {
                what: dd ? dd.textContent.trim() : '', keys: kbds.map(k => k.textContent.trim()), kbdCount: kbds.length, dtOnlyKbd: dt ? [...dt.children].every(c => c.classList.contains('kbd-or') || (c.classList.contains('kbd-combo') && [...c.children].every(k => k.tagName === 'KBD' || k.classList.contains('kbd-plus')))) : false,
                keySat: kbds[0] ? sat(getComputedStyle(kbds[0]).color) : 0, descSat: dd ? sat(getComputedStyle(dd).color) : 1,
                lonePlus: [...row.querySelectorAll('.kbd-plus')].filter(p => { const a = p.previousElementSibling, b = p.nextElementSibling; const t = e => e.getBoundingClientRect().top; return !a || !b || Math.abs(t(a) - t(p)) > 6 || Math.abs(t(b) - t(p)) > 6; }).length,
                glyphUnnamed: kbds.filter(k => /^[⌘⌥⇧⌃↓↑]$/.test(k.textContent.trim()) && !k.getAttribute('aria-label')).map(k => k.textContent).join(''),
                keyColor: kbds[0] ? getComputedStyle(kbds[0]).color : '', descColor: dd ? getComputedStyle(dd).color : '', keyFont: kbds[0] ? getComputedStyle(kbds[0]).fontFamily : '',
                keyRatio: Math.min(...kbds.map(ratio), 99), descRatio: dd ? ratio(dd) : 0,
                stacked: !!(kb && db && db.t >= kb.b - 0.5), underKeys: dd && dt ? Math.min(...lines) < kb.r - 0.5 : true, sameBand: kb && db ? db.l >= kb.r - 0.5 : false, chipsInside: dt ? kbds.every(k => k.getBoundingClientRect().right <= dt.getBoundingClientRect().right + 1) : false,
                orRatio: Math.min(...[...row.querySelectorAll('.kbd-or')].map(ratio), 99)
            };
        });
        const body = m.querySelector('.modal-body'), content = m.querySelector('.modal-content');
        const close = m.querySelector('.modal-header button');
        const sb = document.getElementById('shortcuts-body');
        return { open: true, headings, groups, rows, overflowX: body.scrollWidth > body.clientWidth + 1, contentW: content.getBoundingClientRect().width, viewW: innerWidth, title: (m.querySelector('h3') || {}).textContent, role: m.getAttribute('role'), labelled: !!m.getAttribute('aria-labelledby'),
            bodyRegion: sb.getAttribute('role') + '|' + sb.getAttribute('aria-label') + '|' + sb.tabIndex, overflow: sb.scrollHeight - sb.clientHeight,
            closeName: close ? (close.getAttribute('aria-label') || close.textContent.trim()) : null, closeSize: close ? [close.getBoundingClientRect().width, close.getBoundingClientRect().height] : null, closeVisible: !!close && close.getClientRects().length > 0 };
    })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme, mac] of [[1440, 'light', true], [1440, 'dark', false], [390, 'light', false], [390, 'dark', true]]) {
            const tag = `${w}px ${theme} ${mac ? 'Mac' : 'PC'}`;
            await load(w, theme, mac);
            const d = await ev(READ);
            check(d.open, `${tag}: the dialog is open`);
            if (!d.open) continue;
            check(d.title === 'Keyboard shortcuts' && d.role === 'dialog' && d.labelled, `${tag}: a labelled dialog titled Keyboard shortcuts: ${d.title}`);
            check(JSON.stringify(d.headings) === JSON.stringify(GROUPS), `${tag}: the groups ${GROUPS} in order: ${JSON.stringify(d.headings)}`);
            check(d.groups === GROUPS.length, `${tag}: one list per group: ${d.groups}`);
            check(d.rows.length === 15, `${tag}: 15 rows: ${d.rows.length}`);
            check(!d.overflowX && d.contentW <= d.viewW + 1, `${tag}: no sideways overflow (the dialog is ${d.contentW} of ${d.viewW})`);
            for (const r of d.rows) {
                check(r.kbdCount >= 1 && r.dtOnlyKbd, `${tag}: "${r.what}" keys are <kbd> chips (${r.kbdCount})`);
                check(r.keyColor && r.descColor && r.keyColor !== r.descColor, `${tag}: "${r.what}" keys and description differ in colour (${r.keyColor} / ${r.descColor})`);
                check(/mono|Menlo|Consolas|Courier/i.test(r.keyFont), `${tag}: "${r.what}" keys are monospace (${r.keyFont})`);
                check(r.keyRatio >= 4.5, `${tag}: "${r.what}" keys hold 4.5:1 (${r.keyRatio.toFixed(2)})`);
                check(r.descRatio >= 4.5, `${tag}: "${r.what}" description holds 4.5:1 (${r.descRatio.toFixed(2)})`);
                check(r.orRatio >= 4.5, `${tag}: "${r.what}" the 'or' holds 4.5:1 (${r.orRatio.toFixed(2)})`);
                check(r.keySat >= 0.4 && r.descSat < 0.25, `${tag}: "${r.what}" the keys are in the accent hue (saturation ${r.keySat.toFixed(2)}), the description a neutral (${r.descSat.toFixed(2)})`);
                check(r.lonePlus === 0, `${tag}: "${r.what}" no line starts or ends with a lone +`);
                check(!r.glyphUnnamed, `${tag}: "${r.what}" a glyph chip has a name (${r.glyphUnnamed})`);
                check(r.chipsInside, `${tag}: "${r.what}" the chips stay inside the keys column`);
                check((r.sameBand && !r.underKeys) || r.stacked, `${tag}: "${r.what}" stays in its own column, never under the keys`);
            }
            const flat = d.rows.map(r => r.keys.join(' ')).join(' | ');
            if (mac) check(/⌘/.test(flat) && /⌥/.test(flat) && /⇧/.test(flat) && /⌃/.test(flat) && !/Cmd|Option|Ctrl|Shift/.test(flat), `${tag}: the Mac glyphs, no words: ${flat}`);
            else check(/Ctrl/.test(flat) && /Alt/.test(flat) && /Shift/.test(flat) && !/[⌘⌥⇧⌃]/.test(flat), `${tag}: the words, no Mac glyphs: ${flat}`);
            check(d.closeVisible && /close/i.test(d.closeName || '') && d.closeSize[0] >= 24 && d.closeSize[1] >= 24, `${tag}: a visible, named close button in the header: ${JSON.stringify([d.closeName, d.closeSize])}`);
            if (w === 390) check(d.closeSize && d.closeSize[0] >= 44 && d.closeSize[1] >= 44, `${tag}: the close button is 44 px on a phone: ${JSON.stringify(d.closeSize)}`);
            check(d.bodyRegion === (d.overflow > 0 ? 'region|Keyboard shortcuts list|0' : 'region|Keyboard shortcuts list|-1'), `${tag}: the body is a labelled region, a Tab stop only while it scrolls: ${d.bodyRegion}`);
            if (d.overflow > 0) { // a keyboard user can scroll it: Tab from Close reaches the body, then PageDown scrolls down and Home back up
                await ev(`document.getElementById('shortcuts-close').focus(); true`);
                await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await settle(150);
                check(await ev(`document.activeElement.id`) === 'shortcuts-body', `${tag}: Tab from Close reaches the list: ${await ev('document.activeElement.id || document.activeElement.tagName')}`);
                for (const [k, vk, dir] of [['PageDown', 34, 1], ['Home', 36, -1]]) { const before = await ev(`document.getElementById('shortcuts-body').scrollTop`); await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }); await settle(250); const after = await ev(`document.getElementById('shortcuts-body').scrollTop`); check(dir > 0 ? after > before : after < before, `${tag}: ${k} scrolls the list (${before} to ${after})`); }
            }
            if (tag.startsWith('1440 light')) {
                await ev(`document.querySelector('#shortcuts-modal .modal-header button').click(); true`); await settle(200);
                check((await ev(READ)).open === false, 'the close button closes the dialog');
                await ev(`import((window.__coralStatic || '/static/') + 'shortcuts.js').then(m => m.showShortcuts()).then(() => true)`); await settle(300);
                await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await settle(300);
                check((await ev(READ)).open === false, 'Escape closes the dialog');
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Keyboard shortcuts dialog:\n  ' + problems.slice(0, 40).join('\n  '));
    console.log('PASS the Keyboard shortcuts dialog: keys as <kbd> chips apart from their descriptions, four groups, 4.5:1 in both themes, no wrapping under the keys at 1440 and 390');
})().catch(e => { console.error(e); process.exit(1); });
