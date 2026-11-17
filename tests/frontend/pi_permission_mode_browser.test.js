// #14360 (#14334 point 3): Pi has no permission flag, so its Permission Mode choice changed nothing. The agent form now shows Pi's mode fixed on Default, the select disabled with the one-line reason
// ("Pi has no permission prompts: it always acts on its own."), and gives the choice back when the type changes to a CLI that has modes. 1280 and 390 px.
'use strict';
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const c = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const ev = async expression => {
        const r = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
        return r.result.value;
    };
    const { coralReady } = require('./helpers/wait').bind(ev);
    const WHY = 'Pi has no permission prompts: it always acts on its own.';
    const setType = t => ev(`(() => { const s = document.querySelector('#fixture .acf-agent-type'); s.value = ${JSON.stringify(t)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const mode = () => ev(`(() => { const s = document.querySelector('#fixture .acf-permission-mode'); const hint = s.parentElement.querySelector('.perm-mode-desc'); return { text: s.selectedOptions[0] && s.selectedOptions[0].textContent, value: s.value, disabled: s.disabled, title: s.title, shown: [...s.options].filter(o => !o.hidden && !o.disabled).map(o => o.value), hint: hint ? hint.textContent : null }; })()`);
    try {
        await c.Page.enable();
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await c.Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await c.Page.navigate({ url: BASE + '/' }); await c.Page.loadEventFired();
            await coralReady();
            await ev(`(async () => { await (await import((window.__coralStatic || '/static/') + 'lazy_panels.js')).loadModals();
                const p = document.createElement('div'); p.id = 'fixture'; p.className = 'modal-content';
                p.style.cssText = 'position:fixed;top:20px;left:20px;width:' + Math.min(620, innerWidth - 40) + 'px;height:760px;overflow:auto;z-index:99999;background:var(--bg-primary);padding:16px';
                document.body.append(p);
                window.renderAgentConfigForm('fixture', { showPreset: false, showName: false, value: { agentType: 'claude', permissionMode: 'bypassPermissions', capabilities: { allow: [], deny: [] } } });
                document.querySelector('#fixture .permissions-toggle-btn').click(); return true; })()`);
            let m = await mode();
            assert.equal(m.disabled, false, `${w}px: Claude's mode choice is open`);
            assert.ok(m.shown.includes('bypassPermissions') && m.shown.includes('plan'), `${w}px: Claude offers Bypass and Plan: ${m.shown}`);
            await setType('pi');
            m = await mode();
            console.log(`${w}px Pi:`, JSON.stringify(m));
            if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); const { data } = await c.Page.captureScreenshot({ format: 'png' }); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/pi-agent-form-${w}.png`, Buffer.from(data, 'base64')); }
            assert.equal(m.disabled, true, `${w}px: Pi's mode select is disabled`);
            assert.equal(m.value, 'default', `${w}px: and sits on Default, not the Bypass it had`);
            assert.deepEqual(m.shown, ['default'], `${w}px: no Plan, Bypass or Auto offered for Pi`);
            assert.equal(m.text, 'No permission modes', `${w}px: it reads No permission modes, not Default`);
            assert.equal(m.title, WHY, `${w}px: the reason is on the select`);
            assert.equal(m.hint, WHY, `${w}px: and in the line under it`);
            await setType('claude');
            m = await mode();
            assert.equal(m.disabled, false, `${w}px: the choice comes back for Claude`);
            assert.equal(m.title, '', `${w}px: and the Pi reason is gone`);
            assert.notEqual(m.text, 'No permission modes', `${w}px: and the select reads a mode again`);
            assert.ok(m.shown.includes('plan') && m.shown.includes('bypassPermissions'), `${w}px: Claude's modes are offered again`);
        }
        console.log('pi_permission_mode: ok');
        await c.close(); process.exit(0);
    } catch (e) {
        console.error('FAIL', e && e.stack || e);
        try { await c.close(); } catch { /* closing */ }
        process.exit(1);
    }
})();
