// #17167: New team from Getting started opens the team wizard after password setup, including a delayed launch-dialog opener.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const orig = window.fetch.bind(window), json = x => Promise.resolve(new Response(JSON.stringify(x), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = String(u); if (url.includes('/api/board/projects')) return json([]); if (url === '/api/auth/password/set') return json({ ok: true }); if (url.includes('/api/system/auth-status')) return json({ authenticated: true, password_set: false, local: true }); if (url === '/api/settings' && o.method === 'PUT') return json({ ok: true }); return orig(u, o); };
                T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; T.state.liveSessions = []; T.state.servers = []; return true;
            })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => { m.showSetPasswordModal({ required: true }); return true; })`);
            await ev(`document.getElementById('set-password-new').value = 'Local test password 29!'; document.getElementById('set-password-confirm').value = 'Local test password 29!'; document.getElementById('set-password-form').requestSubmit(); true`);
            await waitFor(`!document.getElementById('set-password-modal')`, 'password setup closed', 8000);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            const button = `[...document.querySelectorAll('#group-table-view .inbox-welcome-actions button')].find(b => b.textContent === 'New team')`;
            await waitFor(`!!(${button})`, 'Getting started New team', 8000);
            await ev(`${button}.click(); true`);
            const teamOpen = `document.getElementById('launch-modal')?.getClientRects().length > 0 && document.getElementById('launch-step-team')?.getClientRects().length > 0`;
            await waitFor(teamOpen, 'one cold click opens New team', 15000);
            await ev(`window.hideLaunchModal(); window.__show = window.showLaunchModal; window.showLaunchModal = (...args) => new Promise(resolve => { window.__openLater = () => { window.__show(...args); resolve(); }; }); ${button}.click(); true`);
            // Controlled partial-load ordering: selection is available while opening is still pending.
            await ev(`window.__openLater(); true`); await ev(framesJs(6));
            if (process.env.CORAL_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
                fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR + '/' + width + '.png', Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            }
            assert.equal(await ev(teamOpen), true, 'team selection waits for the pending dialog opening');
            await ev(`window.showLaunchModal = window.__show; window.hideLaunchModal(); true`);
        }
        console.log('PASS Getting started New team opens after password setup and pending dialog load');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
