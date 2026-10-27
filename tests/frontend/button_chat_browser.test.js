// The chat bubble's Copy and Save for later are the family's dense quiet icon button (#9494, group 3 of #9484): .btn.btn-quiet.btn-icon.btn-xs, a 24 px box with a 44 px hit area on touch, with their own rules only placing them
// in the bubble's corner and revealing them on hover (always on touch). A bubble drawn with the page's own markup constants (saved_marks.js SAVE_BUTTON, chat_messages.js' copy button) in the page's own chat container; 1280 and 390,
// dark and light, with shots. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const COPY = `<button type="button" class="btn btn-quiet btn-icon btn-xs chat-copy-btn" title="Copy" aria-label="Copy message"><span class="material-icons" aria-hidden="true">content_copy</span></button>`;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`;
    const theme = t => ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(async () => { const m = await import(${S} + 'saved_marks.js'); document.getElementById('chat-probe')?.remove();
                const host = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'chat-probe', className: 'chat-messages', style: 'position:fixed;left:16px;top:90px;width:' + Math.min(innerWidth - 32, 560) + 'px;z-index:9999;background:var(--bg-primary);padding:12px;display:flex;flex-direction:column;gap:14px' }));
                host.innerHTML = '<div class="chat-bubble assistant" style="position:relative;padding:10px 40px 10px 12px;border:1px solid var(--border);border-radius:10px">A reply from an agent with a button pair in its corner.' + ${JSON.stringify(COPY)} + m.SAVE_BUTTON + '</div><div class="chat-bubble human" style="position:relative;padding:10px 40px 10px 12px;border:1px solid var(--border);border-radius:10px">A message from the person.' + m.SAVE_BUTTON + '</div>'; return true; })()`);
            const m = await ev(`(() => { const info = sel => [...document.querySelectorAll(sel)].map(b => { const cs = getComputedStyle(b), r = b.getBoundingClientRect(), a = getComputedStyle(b, '::after'); return { cls: b.className, w: Math.round(r.width), h: Math.round(r.height), pos: cs.position, bg: cs.backgroundColor, hit: parseFloat(a.width) || 0, opacity: cs.opacity }; }); return { copy: info('#chat-probe .chat-copy-btn'), save: info('#chat-probe .chat-save-btn') }; })()`);
            assert.equal(m.copy.length, 1); assert.equal(m.save.length, 2);
            const hasHover = await ev(`matchMedia('(hover: hover)').matches`);
            for (const b of m.copy.concat(m.save)) {
                assert.ok(/\bbtn-icon\b/.test(b.cls) && /\bbtn-xs\b/.test(b.cls) && /\bbtn-quiet\b/.test(b.cls), `${at}a dense quiet icon button: ${b.cls}`);
                assert.equal(b.pos, 'absolute', `${at}placed in the bubble's corner`);
                assert.ok(b.w >= 24 && b.w <= 28 && b.h >= 24 && b.h <= 28, `${at}a 24 px box: ${b.w}x${b.h}`);
                if (mobile) assert.ok(b.hit >= 44, `${at}a 44 px hit area on touch: ${b.hit}`);
                if (!hasHover) assert.equal(b.opacity, '1', `${at}no hover to reveal them: always shown (${b.opacity})`);
                if (!mobile && hasHover) assert.equal(b.opacity, '0', `${at}revealed on hover: ${b.opacity}`); // where the pointer can hover; where it cannot (a real touch screen, and the CI's headless Chrome, which reports no hover) they are always shown, as #9642 made the touch rules say: the emulated touch does not switch that media feature
            }
            if (!mobile) { // the hover reveal
                const pt = await ev(`(() => { const r = document.querySelector('#chat-probe .chat-bubble.assistant').getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2]; })()`);
                await Input.dispatchMouseEvent({ type: 'mouseMoved', x: pt[0], y: pt[1] }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the hover transition
                assert.equal(await ev(`getComputedStyle(document.querySelector('#chat-probe .chat-copy-btn')).opacity`), '1', `${at}the buttons show on hover`);
            }
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`btn-chat-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS chat bubble buttons: the family\'s dense quiet icon buttons');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
