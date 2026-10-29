// A select takes the page colour like a text input, and the workflow dialog's Remove step is the icon button (#9457, from UI/UX's #9452 audit items 6 and 9): in the light theme a select no class styled was the browser's pure white where
// the inputs beside it were the page colour; the step's Remove was a typed 11 px "x". Every select in the page's markup (and a bare probe) is not pure white in the light theme; the Remove step is .btn-icon.btn-xs with the close glyph,
// a 24 px box with a 44 px hit area on touch, in both themes, with shots. A real dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const S = `(window.__coralStatic || '/static/')`;
    const theme = t => ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.showWorkflowCreateModal(); true`);
            await waitFor(`!!document.querySelector('#wf-steps-editor .wf-step-remove-btn')`, 'the workflow dialog with a step', 10000);
            for (const t of ['light', 'dark']) {
                await theme(t); await new Promise(r => setTimeout(r, 450)); // sleep-ok: the theme's colour transition settles
                const r = await ev(`(() => { const probe = document.body.appendChild(document.createElement('select')); const page = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(); const tmp = document.createElement('i'); tmp.style.background = 'var(--bg-primary)'; document.body.append(tmp); const want = getComputedStyle(tmp).backgroundColor; tmp.remove();
                    const selects = [...document.querySelectorAll('select')].map(s => ({ id: s.id || s.className, bg: getComputedStyle(s).backgroundColor })); const bare = getComputedStyle(probe).backgroundColor; probe.remove();
                    const b = document.querySelector('#wf-steps-editor .wf-step-remove-btn'), cs = getComputedStyle(b), rect = b.getBoundingClientRect();
                    return { want, bare, white: selects.filter(s => s.bg === 'rgb(255, 255, 255)'), btn: { cls: b.className, glyph: b.querySelector('.material-icons')?.textContent, label: b.getAttribute('aria-label'), w: Math.round(rect.width), h: Math.round(rect.height), hit: parseFloat(getComputedStyle(b, '::after').width) || 0, text: b.textContent } }; })()`);
                assert.equal(r.bare, r.want, `${at}${t}: a select no class styles is the page colour: ${r.bare} vs ${r.want}`);
                if (t === 'light') assert.deepEqual(r.white, [], `${at}no select is pure white in the light theme`);
                assert.ok(/\bbtn-icon\b/.test(r.btn.cls) && /\bbtn-xs\b/.test(r.btn.cls) && r.btn.glyph === 'close' && r.btn.text === 'close', `${at}${t}: Remove step is the icon button with the close glyph: ` + JSON.stringify(r.btn));
                assert.match(r.btn.label, /^Remove step \d+$/, `${at}its name is "Remove step N"`);
                assert.ok(r.btn.w >= 24 && r.btn.h >= 24 && (!mobile || r.btn.hit >= 44), `${at}${t}: a 24 px box, a 44 px hit area on touch (the family's ::after): ${JSON.stringify(r.btn)}`);
                await shot(`light-selects-${t}-${w}`);
            }
        }
        console.log('PASS light selects: no pure white select in the light theme; Remove step is the icon button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
