// The Google sign-in block in Settings > Storage and cleanup (#20022): shown with Connect when not connected, Connect asks this Coral and opens Google's own
// page, connected it shows Disconnect and never the account id, a Hub refusal says it is the computer's own. The server's answers are the page's fetch.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shown = id => ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el || el.closest('[hidden]')) return false; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
                window.__g = { client_file_set: true, client_file_ok: true, connected: false, state: 'disconnected' }; window.__connects = 0; window.__disc = 0; window.__opened = [];
                window.open = (u) => { window.__opened.push(String(u)); return {}; };
                window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                    if (p === '/api/google/status' && m === 'GET') return window.__gstatus ? json(window.__gstatus.body, window.__gstatus.status) : json(window.__g);
                    if (p === '/api/google/connect' && m === 'POST') { window.__connects++; return json({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test' }); }
                    if (p === '/api/google/disconnect' && m === 'POST') { window.__disc++; window.__g = { client_file_set: true, client_file_ok: true, connected: false, state: 'disconnected' }; return json({ connected: false, revoked: true }); }
                    return real(u, o); };
                return true; })()`);
            await ev(`window.showSettingsModal('cleanup'); true`);
            await waitFor(`!!document.getElementById('settings-pane-cleanup') && !document.getElementById('settings-pane-cleanup').hidden`, 'the Storage and cleanup page', 8000);
            await waitFor(`/Not connected/.test((document.getElementById('settings-google-status') || {}).textContent || '')`, 'the Google status to be read', 8000);
            check(`${tag}: the Google block is shown in Storage and cleanup`, await shown('settings-google') && await ev(`!!document.getElementById('settings-google').closest('#settings-pane-cleanup')`));
            check(`${tag}: Connect is shown`, await shown('settings-google-connect'));
            check(`${tag}: Disconnect is not shown`, !(await shown('settings-google-disconnect')));
            await ev(`document.getElementById('settings-google-connect').click(); true`);
            await waitFor(`window.__connects > 0 && window.__opened.length > 0`, 'the connect request and Google\'s page', 6000);
            check(`${tag}: Connect asks this Coral and opens Google's page`, (await ev(`window.__connects`)) === 1 && (await ev(`window.__opened[0]`)).startsWith('https://accounts.google.com/'));
            await ev(`import((window.__coralStatic || '/static/') + 'google_settings.js').then(m => m.stopGooglePoll()); true`);

            await ev(`window.__g = { client_file_set: true, client_file_ok: true, connected: true, state: 'connected', account_id: 'ACCOUNT-ID-MUST-NOT-SHOW' };
                import((window.__coralStatic || '/static/') + 'google_settings.js').then(m => m.loadGoogle()).then(() => true)`);
            await waitFor(`/Connected to Google/.test(document.getElementById('settings-google-status').textContent)`, 'the connected status', 6000);
            check(`${tag}: connected, Disconnect is shown and Connect is not`, await shown('settings-google-disconnect') && !(await shown('settings-google-connect')));
            check(`${tag}: the account id is never on the page`, !(await ev(`document.getElementById('settings-google').textContent.includes('ACCOUNT-ID-MUST-NOT-SHOW')`)));
            check(`${tag}: no sideways scroll`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await ev(`document.getElementById('settings-google-disconnect').click(); true`);
            await waitFor(`window.__disc > 0 && /Not connected/.test(document.getElementById('settings-google-status').textContent)`, 'Disconnect', 6000);
            check(`${tag}: Disconnect asks this Coral and the block says not connected`, true);

            await ev(`window.__g = { client_file_set: false, client_file_ok: false, connected: false, state: 'disconnected' };
                import((window.__coralStatic || '/static/') + 'google_settings.js').then(m => m.loadGoogle()).then(() => true)`);
            await waitFor(`/isn't set up on this computer/.test(document.getElementById('settings-google-status').textContent)`, 'the no client file status', 6000);
            check(`${tag}: with no client file there are no buttons`, !(await shown('settings-google-connect')) && !(await shown('settings-google-disconnect')));

            await ev(`window.__gstatus = { status: 403, body: { error: 'x', code: 'local_dashboard_required' } };
                import((window.__coralStatic || '/static/') + 'google_settings.js').then(m => m.loadGoogle()).then(() => true)`);
            await waitFor(`/not through Coral Hub/.test(document.getElementById('settings-google-status').textContent)`, 'the Hub refusal text', 6000);
            check(`${tag}: through Coral Hub it says it is the computer's own, with no buttons`, !(await shown('settings-google-connect')));
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Google settings checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
