// The three dialog sizes as the page draws them (Goal #89, #9320): .dlg-confirm is 28 rem, .dlg-form 40 rem and .dlg-flow 60 rem (at most 94vw) on a wide screen, and a dialog is never wider than 95vw (on a phone it is that wide); a
// confirmation built as a dialog element (the auto-accept one, the Goals ones) wears the same size. Probes of each size plus every dialog in the page's own markup; 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const m = await ev(`(() => { const out = {}; const host = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'dlg-probes', style: 'position:fixed;left:0;top:0;visibility:hidden' }));
                for (const k of ['confirm', 'form', 'flow']) { const d = document.createElement('div'); d.className = 'modal-content dlg-' + k; host.append(d); out[k] = Math.round(d.getBoundingClientRect().width); }
                const dd = document.createElement('dialog'); dd.className = 'dlg-confirm'; dd.setAttribute('open', ''); host.append(dd); out.dialog = Math.round(dd.getBoundingClientRect().width);
                out.own = [...document.querySelectorAll('.modal-content[class*="dlg-"]')].map(e => ({ cls: e.className, w: Math.round(e.getBoundingClientRect().width), inline: e.getAttribute('style') || '' }));
                out.screen = innerWidth; return out; })()`);
            const cap = Math.round(m.screen * 0.95);
            const want = mobile ? { confirm: cap, form: cap, flow: cap } : { confirm: 448, form: 640, flow: 960 };
            assert.deepEqual({ confirm: m.confirm, form: m.form, flow: m.flow }, want, at + 'the three dialog widths');
            assert.equal(m.dialog, want.confirm, at + 'a dialog element wears the same confirm size');
            for (const o of m.own) assert.ok(!/width/.test(o.inline) && o.w <= cap + 1, at + `${o.cls}: no inline width, never wider than the screen less a margin: ` + JSON.stringify(o));
        }
        console.log('PASS dialog sizes: 28, 40 and 60 rem on a wide screen, 95vw on a phone; no inline widths');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
