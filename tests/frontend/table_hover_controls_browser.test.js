// The controls a table row shows on its hover (a chat's Star and Archive .dt-flag, the Saved Done button .dt-hover-action, the select star .dt-star) are not left showing by the focus a mouse click leaves (#11814, the same bug as #11800
// on Needs you rows): the control shows while its row is hovered and for the keyboard's focus, and goes back to rest when the pointer moves to another row after a click. The rows are drawn in the page with the dashboard's own
// classes, so the stylesheet is the real one. 1440 with a mouse. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const host = document.createElement('div'); host.id = 'hover-fixture'; host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg-primary);padding:24px';
            host.innerHTML = '<div class="dt-box"><table class="dt-table"><tbody>' + [1, 2].map(n => '<tr class="dt-row" data-n="' + n + '"><td style="height:56px;padding:0 16px"><button type="button" class="dt-flag" data-c="flag" aria-label="Star ' + n + '">*</button> <button type="button" class="dt-hover-action" data-c="action">Done ' + n + '</button> <button type="button" class="dt-star" data-c="star" aria-label="Select ' + n + '">+</button></td></tr>').join('') + '</tbody></table></div>';
            document.body.append(host); return true; })()`);
        await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
        const opacity = (n, c) => ev(`Number(getComputedStyle(document.querySelector('#hover-fixture tr[data-n="${n}"] [data-c="${c}"]')).opacity)`);
        const centre = (n, c) => ev(`(() => { const r = document.querySelector('#hover-fixture tr[data-n="${n}"]' + ${JSON.stringify(c ? ` [data-c="${c}"]` : '')}).getBoundingClientRect(); return { x: r.left + (${c ? '0.5' : '0.9'}) * r.width, y: r.top + r.height / 2 }; })()`);
        const move = p => client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y });
        await move({ x: 5, y: 5 }); await ev(framesJs(3));
        for (const c of ['flag', 'action', 'star']) {
            check(await opacity(1, c) === 0, `${c}: at rest the control is transparent`);
            const at = await centre(1, c);
            await move(at); await ev(framesJs(2));
            check(await opacity(1, c) === 1, `${c}: it shows while its row is hovered`);
            for (const type of ['mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
            await move(await centre(2)); await ev(framesJs(3));
            check(await opacity(1, c) === 0, `${c}: after a click and the pointer moving to another row, the first row's control is back at rest (was left showing by the click's focus)`);
            check(await opacity(2, c) === 1, `${c}: the hovered row shows its control`);
            await move({ x: 5, y: 5 }); await ev(framesJs(2));
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft' }); // a key press: the focus that follows is the keyboard's, as a Tab's would be
            await ev(`document.querySelector('#hover-fixture tr[data-n="2"] [data-c="${c}"]').focus(); true`); await ev(framesJs(2));
            check(await opacity(2, c) === 1 && await opacity(1, c) === 0, `${c}: the keyboard's focus shows the row's control`);
            await ev(`document.activeElement.blur(); true`);
        }
        await ev(`document.getElementById('hover-fixture').remove(); true`);
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('table_hover_controls_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
