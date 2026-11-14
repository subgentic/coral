// Password recovery links lead to public Docs, keeping commands out of dialogs (#15858).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady } = require('./helpers/wait').bind(ev);
    const failures = [];
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`document.documentElement.dataset.theme = '${theme}'; document.documentElement.style.fontSize = '32px'; import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => m.showSetPasswordModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('set-password-modal')`, 'password dialog');
            const result = await ev(`(() => { const m = document.getElementById('set-password-modal'), a = m.querySelector('a[href="/static/password-reset.html"]'); return { command: m.textContent.includes('coral reset-password'), link: a?.textContent, target: a?.target, rel: a?.rel }; })()`);
            await shot(`password-help-${width}-${theme}-200`);
            if (width === 390) {
                const height = await ev(`(() => { document.documentElement.style.fontSize = '16px'; const a = document.querySelector('#set-password-modal a'); return a?.getBoundingClientRect().height || 0; })()`);
                assert.ok(height >= 44, 'recovery link has a touch target at normal text size');
            }
            if (result.command || result.link !== 'Forgot password' || result.target !== '_blank' || result.rel !== 'noopener') failures.push({ width, theme, result });
            const signin = fs.readFileSync(require('node:path').join(__dirname, '../../coral-go/internal/auth/testdata/auth_page_signin.html'), 'utf8');
            const frameId = (await Page.getFrameTree()).frameTree.frame.id;
            await Page.setDocumentContent({ frameId, html: signin });
            await waitFor(`!!document.getElementById('show-forgot')`, 'sign-in help markup');
            await ev(`document.documentElement.dataset.theme = '${theme}'; document.documentElement.style.fontSize = '32px'; true`);
            const auth = await ev(`({ command: /coral (?:reset-password|open|setup-code)/.test(document.body.textContent), href: document.getElementById('show-forgot')?.getAttribute('href') })`);
            await shot(`signin-help-${width}-${theme}-200`);
            if (auth.command || auth.href !== '/static/password-reset.html') failures.push({ width, theme, auth });

        }
        assert.deepEqual(failures, [], 'a safe Docs link replaces the command in every dialog');
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/static/password-reset.html' }); await Page.loadEventFired();
        assert.equal(await ev(`location.pathname`), '/static/password-reset.html', 'recovery needs no sign-in redirect');
        assert.equal(await ev(`document.querySelector('h1').textContent`), 'Reset your password');
        assert.equal(await ev(`document.querySelector('code').textContent`), 'coral reset-password', 'the command is in Docs');
        await ev(`document.documentElement.dataset.theme = 'light'; document.documentElement.style.fontSize = '32px'; true`);
        await shot('password-recovery-docs-390-light-200');
    } finally { await client.close(); }
    console.log('PASS password recovery is a Docs link and the Docs page is public');
})().catch(e => { console.error(e); process.exitCode = 1; });
