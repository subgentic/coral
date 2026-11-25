// "Comment on the whole document" is reachable the moment the Comments sheet opens in a short docked preview pane (#20660, QA2's walk on e65ff15e8a): at 1400x900 and 1280x800 the docked pane is ~280 px tall, so the
// sheet (half of it) was ~100 px and the button sat below the fold until the sheet was scrolled; at 390x844 too. The button now stays in view at the sheet's foot, and a closed sheet takes no clicks. The check is
// elementFromPoint at the button's centre right after the sheet opens, with several comments (so the button is not just near the top), and again after it closes. Real server, comments stubbed (helpers/comments_scale.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const { STUB, HEX } = require('./helpers/comments_scale');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const CONTENT = ['# Pricing', '', 'The starter plan costs nine dollars a month and includes three seats for the whole team.', '', 'The team plan costs thirty dollars a month and includes twenty seats and the audit log.', '', 'Enterprise is quoted by sales and includes single sign-on and a named contact.'].join('\n');
const COMMENTS = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, parent_id: null, anchor: { quote: 'costs nine dollars a month' }, body: 'Comment ' + (i + 1) + ': is this per seat, and what about the annual discount?', author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date(Date.now() - (i + 1) * 3600000).toISOString() }));
const FX = { filename: 'pricing.md', content: CONTENT, size: CONTENT.length, mediaType: 'text/markdown', comments: COMMENTS };


(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a layout settle after a resize or a tap
    await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
    const load = async (w, h, mobile, theme) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev); await setTheme(ev, theme);
        await ev(`(async()=>{(await import(${S} + 'safe_storage.js')).browserLocal.remove('coral-artifact-comments-open');})()`);
        await ev(STUB(FX));
        await ev(`(async () => { const st = ${S}; const { state } = await import(st + 'state.js'); window.PP = await import(st + 'preview_pane.js'); const { showView } = await import(st + 'utils.js');
            state.currentSession = { type: 'live', name: 'boss', session_id: 'boss-sid', agent_type: 'claude' }; showView('live-session-view'); window.PP.setPreviewSession('boss-sid'); return true; })()`);
    };
    const open = async (hex, name, type) => {
        await ev(`window.PP.openArtifactTab('coral://artifacts/' + ${JSON.stringify(hex)}, { name: ${JSON.stringify(name)}, mediaType: ${JSON.stringify(type)} }); true`);
        await waitFor(`getComputedStyle(document.getElementById('preview-pane')).display !== 'none'`, 'the pane', { timeout: 8000 });
    };
    try {
        for (const [w, h, mobile] of [[1400, 900, false], [1280, 800, false], [390, 844, true]]) {
            const tag = `${w}x${h}`;
            await load(w, h, mobile, 'dark');
            await open(HEX, 'pricing.md', 'text/markdown');
            await waitFor(`!!document.querySelector('#preview-body .preview-pane-markdown') && document.querySelectorAll('#preview-main .ac-card').length > 0`, `${tag}: the document and its comments`, 10000);
            const opened = await ev(`(() => { const p = document.querySelector('#preview-main .ac-panel'); return !!p && p.classList.contains('ac-sheet-open'); })()`);
            if (!opened) { await ev(`document.querySelector('#preview-toolbar .ac-toggle').click(); true`); await settle(500); }
            const reach = () => ev(`(() => { const w = document.querySelector('#preview-main .ac-whole'), main = document.getElementById('preview-main'); if (!w) return { none: true }; const r = w.getBoundingClientRect(), m = main.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
                const at = document.elementFromPoint(x, y); return { x: Math.round(x), y: Math.round(y), inMain: y >= m.top && y <= m.bottom && x >= m.left && x <= m.right, hit: !!at && (at === w || w.contains(at)), atPanel: !!(at && at.closest('.ac-panel')), pane: Math.round(m.height) }; })()`);
            let r = await reach();
            check(`${tag}: right after the sheet opens, Comment on the whole document is on screen and is what a click at its centre hits (pane ${r.pane} px)`, r.inMain && r.hit, JSON.stringify(r));
            await shot(`preview-whole-${tag}`);
            const x = r.x, y = r.y;
            await ev(`document.querySelector('#preview-main .ac-sheet-close')?.click(); true`); await settle(500);
            const closed = await ev(`(() => { const at = document.elementFromPoint(${x}, ${y}); return { atPanel: !!(at && at.closest('.ac-panel')), tag: at && (at.id || at.className) }; })()`);
            check(`${tag}: a closed sheet takes no clicks where the button was`, closed.atPanel === false, JSON.stringify(closed));
        }
    } catch (e) { console.error(e); results.push(false); }
    process.exit(results.length && results.every(Boolean) ? 0 : 1);
})();
