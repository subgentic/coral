// One dialog footer (#15816, guideline 4.8), proved on New job: Cancel then the one Primary, right-aligned; a destructive Quiet button (.btn-quiet.btn-danger, added to the footer here) sits alone at the far left whatever its place in the markup;
// the footer stays in view while a long body scrolls (390 touch and 200% text); Escape does what Cancel does. 1440 dark and light. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const Input = client.Input;
    const problems = []; const check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, theme, zoom, mobile] of [['1440 dark', 1440, 900, 'dark', ''], ['1440 light', 1440, 900, 'light', ''], ['1440 200% text', 1440, 700, 'dark', '200%'], ['390 touch dark', 390, 640, 'dark', '', true], ['390 touch light', 390, 640, 'light', '', true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile }); await Emulation.setTouchEmulationEnabled({ enabled: !!mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; Promise.resolve(window.showJobModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('job-modal-submit') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, `${label}: the New job dialog`, 8000);
            await ev(`(() => { const f = document.getElementById('job-footer'); const d = document.createElement('button'); d.type = 'button'; d.id = 'probe-delete'; d.className = 'btn btn-quiet btn-danger'; d.textContent = 'Delete'; f.append(d); return true; })()`);
            await ev(`document.fonts.ready.then(() => ${framesJs(3, 600)})`);
            const g = await ev(`(() => { const f = document.getElementById('job-footer'), fr = f.getBoundingClientRect(), box = r => { const x = r.getBoundingClientRect(); return { l: Math.round(x.left), r: Math.round(x.right), t: Math.round(x.top), b: Math.round(x.bottom) }; };
                const cancel = [...f.querySelectorAll('button')].find(b => /^cancel$/i.test(b.textContent.trim())), prim = document.getElementById('job-modal-submit'), del = document.getElementById('probe-delete');
                const body = document.querySelector('#job-modal .modal-body') || document.getElementById('job-form'); const sc = [...document.querySelectorAll('#job-modal *')].find(e => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
                if (sc) sc.scrollTop = sc.scrollHeight;
                return { f: box(f), cancel: cancel && box(cancel), prim: box(prim), del: box(del), delHover: del.matches(':hover'), delBorder: getComputedStyle(del).borderTopColor, scrolls: !!sc, vw: innerWidth, vh: innerHeight, primCls: prim.className, cancelCls: cancel ? cancel.className : '' }; })()`);
            const at = label + ': ';
            check(g.cancel && g.cancel.r <= g.prim.l + 1, `${at}Cancel comes before the Primary (${JSON.stringify(g.cancel)} / ${JSON.stringify(g.prim)})`);
            check(g.del.l <= g.f.l + 30 && g.del.r <= g.cancel.l + 1, `${at}the destructive Quiet button is alone at the far left (${JSON.stringify(g.del)}, footer ${g.f.l})`);
            check(g.delHover || /rgba\(0, 0, 0, 0\)|transparent/.test(g.delBorder), `${at}the destructive button is Quiet: no box until hovered (${g.delBorder})`);
            check(g.prim.r >= g.f.r - 30, `${at}the Primary is at the right edge (${g.prim.r} of ${g.f.r})`);
            check(g.f.b <= g.vh + 1 && g.f.t >= 0 && g.f.r <= g.vw + 1, `${at}the footer is in view (${JSON.stringify(g.f)} in ${g.vw}x${g.vh})`);
            if (mobile || zoom) check(g.scrolls, `${at}the body is long enough to scroll here, so the footer staying put is a real test`);
            await shot('footer-' + label.replace(/ /g, '-'));
            await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await waitFor(`getComputedStyle(document.getElementById('job-modal')).display === 'none'`, `${at}Escape closes the dialog as Cancel does`, 5000);
        }
    } finally { try { await client.close(); } catch (e) {} }
    assert.deepEqual(problems, [], 'The dialog footer:\n  ' + problems.join('\n  '));
    console.log('PASS one dialog footer');
})().catch(e => { console.error(e); process.exit(1); });
