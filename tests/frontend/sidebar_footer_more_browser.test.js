// #20541: More reaches the existing chooser without changing either direct launch or the phone FAB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { themeJs } = require('./helpers/theme');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        const { data } = await Page.captureScreenshot({ format: 'png' });
        fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR, name + '.png'), Buffer.from(data, 'base64'));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__m.add('sample-agent', 'A', 3); T.render.renderLiveSessions(T.state.liveSessions); window.switchNavTab('agents'); ${themeJs(theme)}; true`);
            await ev(`Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => true)`);
            const tag = `${width}-${theme}`;
            await shot(tag + '-footer');
            if (width === 390) {
                assert.equal(await ev(`document.querySelector('.sidebar-footer').checkVisibility()`), false, 'phone retains its own FAB');
                await waitFor(`document.getElementById('phone-fab').checkVisibility()`, 'phone FAB visible');
                await ev(`document.getElementById('phone-fab').click(); true`);
                await waitFor(`!document.getElementById('phone-fab-menu').hidden`, 'phone New menu');
                const types = await ev(`[...document.querySelectorAll('#phone-fab-menu [data-on-click="phone-fab-new"]')].map(b => b.dataset.arg)`);
                assert.deepEqual(types, ['agent', 'team'], 'phone creation options unchanged');
                await shot(tag + '-phone-menu');
                continue;
            }
            const footer = await ev(`(() => { const f=document.querySelector('.sidebar-footer'), bs=[...f.querySelectorAll('button')], fr=f.getBoundingClientRect(); return {names:bs.map(b=>b.textContent.trim()), primary:bs[0].classList.contains('btn-primary'), actions:bs.map(b=>[b.dataset.onClick,b.dataset.arg||'']), fits:bs.every(b=>{const r=b.getBoundingClientRect();return r.left>=fr.left&&r.right<=fr.right&&r.top>=0&&r.bottom<=innerHeight&&b.scrollWidth<=b.clientWidth+1;})}; })()`);
            if (JSON.stringify(footer.names) !== JSON.stringify(['New team', 'More'])) problems.push(tag + ': ' + JSON.stringify(footer));
            assert.equal(footer.primary, false); assert.equal(footer.fits, true);
            assert.deepEqual(footer.actions, [['m-show-launch-modal-then-select-launch-type','team'],['launch-chooser-show','']]);
            const more = await ev(`(() => {const b=document.querySelector('.sidebar-footer [data-on-click="launch-chooser-show"]'); if(!b)return false; b.focus(); return {popup:b.getAttribute('aria-haspopup'),controls:b.getAttribute('aria-controls'),label:b.getAttribute('aria-label')};})()`);
            assert.ok(more, 'More must keep the chooser action');
            assert.equal(more.popup, 'dialog'); assert.equal(more.controls, 'launch-modal'); assert.match(more.label, /New agent or project/);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await waitFor(`document.getElementById('launch-modal')?.style.display==='flex' && document.getElementById('launch-step-chooser').checkVisibility()`, 'More opens chooser from keyboard');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#launch-step-chooser .launch-type-label')].map(e=>e.textContent.trim())`), ['New agent','New team','Open folder','Terminal']);
            await waitFor(`document.getElementById('launch-modal').contains(document.activeElement)`, 'dialog receives focus');
            assert.equal(await ev(`document.getElementById('launch-modal').contains(document.activeElement)`), true, 'dialog receives focus');
            await shot(tag + '-chooser');
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await waitFor(`document.getElementById('launch-modal').style.display==='none'`, 'Escape closes chooser');
            await waitFor(`document.activeElement.dataset.onClick === 'launch-chooser-show'`, 'focus returns to More');
            assert.equal(await ev(`document.activeElement.dataset.onClick`), 'launch-chooser-show', 'closing returns focus to More');
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 1 });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 1 });
            await waitFor(`document.getElementById('launch-step-agent').checkVisibility()`, 'Alt+N still opens New agent directly');
            assert.equal(await ev(`document.getElementById('launch-step-chooser').checkVisibility()`), false);
            await ev(`window.hideLaunchModal(); true`);
        }
        assert.deepEqual(problems, []);
        console.log('PASS sidebar New team | More; chooser keyboard/focus/aria; 1280/390 light/dark; phone FAB unchanged');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
