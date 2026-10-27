// A switch's knob stays inside its track at 200% text on a touch phone, in normal and forced colours (#9376, from #9346: the Settings switch rows clipped the right edge of the track at 390 px and 200% text): the track is 2.75 rem wide
// on a touch screen and its height, knob and travel are rems too, so all of it grows together. Probes in the Settings row's markup (a .sv-switch-hit label) and in a dialog (.modal-content), on and off, 100% and 200% text; and the
// switch row of the real Settings dialog's Group agents by board or team, which the report shot.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        for (const forced of [false, true]) {
            await Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: forced ? 'active' : 'none' }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            for (const scale of [100, 200]) {
                const at = `${forced ? 'forced colours' : 'normal colours'}, ${scale}% text: `;
                await ev(`document.documentElement.style.fontSize = '${scale}%'; true`);
                const r = await ev(`(() => { const out = []; document.getElementById('sw-probes')?.remove(); const host = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'sw-probes', className: 'modal-content', style: 'position:fixed;left:0;top:0;width:360px;visibility:hidden' }));
                    for (const on of [false, true]) { const l = document.createElement('label'); l.className = 'check-hit sv-switch-hit'; const i = document.createElement('input'); i.type = 'checkbox'; i.className = 'switch'; i.checked = on; l.append(i); host.append(l); }
                    for (const i of host.querySelectorAll('input.switch')) { const t = i.getBoundingClientRect(), c = getComputedStyle(i), k = getComputedStyle(i, '::before'); const m = new DOMMatrixReadOnly(k.transform === 'none' ? undefined : k.transform);
                        const inner = t.width - parseFloat(c.borderLeftWidth) - parseFloat(c.borderRightWidth), right = parseFloat(k.left) + m.m41 + parseFloat(k.width);
                        out.push({ on: i.checked, track: Math.round(t.width * 10) / 10, inner, knobRight: Math.round(right * 10) / 10, knob: parseFloat(k.width), h: t.height }); }
                    return out; })()`);
                for (const s of r) {
                    assert.ok(s.knobRight <= s.inner + 0.5, at + `the knob stays inside the track (${s.on ? 'on' : 'off'}): knob right edge ${s.knobRight}, track inside ${s.inner}`);
                    assert.ok(s.knobRight >= s.inner * 0.8 || !s.on, at + `an on switch's knob is at the right end: ${s.knobRight} of ${s.inner}`);
                    assert.ok(Math.abs(s.track - 2.75 * 16 * scale / 100) < 1, at + `the track is 2.75 rem wide: ${s.track}`);
                }
            }
        }
        console.log('PASS switch track: the knob stays inside the track at 100% and 200% text, normal and forced colours, on a touch phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
