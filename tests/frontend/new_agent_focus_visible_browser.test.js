// A person using the keyboard must SEE where the focus is when step 3 of New agent opens with the selected tab focused (WCAG 2.4.7 Focus Visible; #7391 round 2: quiet_focus.js hides the ring until a key is pressed, so a
// keyboard user who pressed Enter on Next sees none). With the mouse the ring stays quiet (UI/UX's design). Written by QA for the #7391 review. Controls by role and name (helpers/new_agent.js). 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, scenarios, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const { Input } = client;
    const S = scenarios();
    const key = async (k, vk, text) => { for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && text ? { text } : {}) }); await settle(200); };
    const ring = () => ev(`(() => { const a = document.activeElement; if (!a) return null; const s = getComputedStyle(a); return { name: window.__na.name(a), role: a.getAttribute('role'), fv: a.matches(':focus-visible'), outline: s.outlineStyle + ' ' + s.outlineWidth, shadow: s.boxShadow === 'none' ? 'none' : 'shadow' }; })()`);
    const shown = r => (r.outline && !/^none/.test(r.outline) && !/ 0px$/.test(r.outline)) || r.shadow !== 'none';
    const toStep2 = async () => {
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewAgent(ev, waitFor);
        await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.value = '/work/payments-app'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await ev(`window.__na.find('button', ${N.next}).click(); true`); await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNA(ev); await stubModels(ev);
        await S.run('mouse: clicking Next reaches step 3 and the ring stays quiet (the design)', async () => {
            await toStep2();
            const bx = await ev(`window.__na.box(window.__na.find('button', ${N.next}))`); const cx = bx.x + bx.w / 2, cy = bx.y + bx.h / 2;
            await Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy }); await Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
            await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000); await settle(400);
            const quiet = await ring(); assert.equal(quiet.role, 'tab'); assert.equal(quiet.fv, false, `after a mouse click the browser shows no keyboard ring (the design): ${JSON.stringify(quiet)}`);
        });
        await S.run('keyboard: Enter on Next reaches step 3 with the selected tab focused and a VISIBLE focus indicator on it', async () => {
            await ev(`window.hideLaunchModal(); true`); await settle(200); await toStep2();
            await ev(`window.__na.find('button', ${N.next}).focus(); true`); await key('Enter', 13, '\r');
            await waitFor(`/Step 3 of 3/.test(window.__na.dialog().textContent)`, 'step 3', 4000); await settle(400);
            const r = await ring(); assert.equal(r.role, 'tab', `the focus is on ${JSON.stringify(r)}`);
            assert.ok(r.fv, ':focus-visible matches after a keyboard action'); assert.ok(shown(r), `a keyboard user cannot see the focus: outline ${r.outline}, shadow ${r.shadow}`);
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
