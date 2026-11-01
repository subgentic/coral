// Team settings > Messaging, one state per switch (#11718, then #11788): with cross_team_messaging_set and cross_team_artifacts_set false both switches read on and nothing says "default"; one line says teams on this computer are
// not allowed yet, and its Allow stores the explicit on for messaging and files in one PUT (neither value changed, which the page used to skip) and the line then says allowed; an ordinary Save still sends only what changed. The route's
// answers are stubbed in the page (the server half is be-11708). 1440 and 390. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`, TEAM = 'xt11718';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const real = window.fetch; window.__puts = []; window.__s = { cross_team_messaging: true, cross_team_artifacts: true, cross_team_messaging_set: false, cross_team_artifacts_set: false };
                const json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin).pathname, m = (o.method || 'GET').toUpperCase();
                    if (p === '/api/board/${TEAM}/settings' && m === 'GET') return json(window.__s);
                    if (p === '/api/board/${TEAM}/settings' && m === 'PUT') { const b = JSON.parse(o.body); window.__puts.push(b); if ('cross_team_messaging' in b) { window.__s.cross_team_messaging = b.cross_team_messaging; window.__s.cross_team_messaging_set = true; } if ('cross_team_artifacts' in b) { window.__s.cross_team_artifacts = b.cross_team_artifacts; window.__s.cross_team_artifacts_set = true; } return json({ ok: true }); }
                    if (p === '/api/board/${TEAM}/cross-team-state') return json({ error: 'none' }, 404);
                    return real(u, o); }; return true; })()`);
            await ev(`(async () => { const host = document.createElement('div'); host.id = 'xt-host'; host.style.cssText = 'padding:16px;max-width:640px'; document.body.prepend(host); const { mountMessaging } = await import(${S} + 'team_cross_team_fields.js'); window.__view = await mountMessaging(host, '${TEAM}', { settings: { ...window.__s }, state: null }); return true; })()`);
            await waitFor(`!!document.querySelector('#xt-host [name="cross_team_messaging"]')`, at + 'the switches are drawn', 8000);
            const here = () => ev(`(() => { const e = document.querySelector('#xt-host .xt-reach-here'); return e ? { text: e.textContent.replace(/\\s+/g, ' ').trim(), button: !!e.querySelector('button') } : null; })()`);
            const on = k => ev(`document.querySelector('#xt-host [name="${k}"]').checked`);
            check(await on('cross_team_messaging') && await on('cross_team_artifacts'), at + 'both switches read on, as a send finds them');
            check(await ev(`!/\\(default\\)|Set on|Message teams here/.test(document.getElementById('xt-host').textContent) && !document.querySelector('#xt-host .xt-set')`), at + 'one state per switch: no "(default)", no "Set on", no "Message teams here"');
            let hr = await here();
            check(hr && hr.text === 'Teams on this computer: not allowed yet. Allow' && hr.button, at + 'one line about this computer, with Allow: ' + JSON.stringify(hr));
            await shot(`messaging-default-${w}`);
            await ev(`document.querySelector('#xt-host button[data-act="allow-here"]').click(); true`);
            await waitFor(`window.__puts.length === 1`, at + 'Allow is saved', 6000).catch(() => {});
            check(JSON.stringify(await ev(`window.__puts.map(b => Object.keys(b).filter(k => k !== 'subscriber_id').sort())`)) === JSON.stringify([['cross_team_artifacts', 'cross_team_messaging']]), at + 'Allow stores the explicit on for messaging and files in one request, though neither changed: ' + JSON.stringify(await ev(`window.__puts`)));
            await waitFor(`/allowed\\.$/.test((document.querySelector('#xt-host .xt-reach-here') || {}).textContent || '')`, at + 'the line follows', 6000).catch(() => {});
            hr = await here();
            check(hr && hr.text === 'Teams on this computer: allowed.' && !hr.button, at + 'the line says allowed, with no button: ' + JSON.stringify(hr));
            // an ordinary change still sends only what changed
            await ev(`window.__view.set('cross_team_messaging', false); window.__view.save().then(() => true)`).catch(() => {});
            await waitFor(`window.__puts.length === 2`, at + 'the ordinary save', 6000).catch(() => {});
            check(JSON.stringify(await ev(`window.__puts[1] ? Object.keys(window.__puts[1]).filter(k => k !== 'subscriber_id') : null`)) === JSON.stringify(['cross_team_messaging']), at + 'an ordinary Save sends only the switch that changed: ' + JSON.stringify(await ev(`window.__puts[1]`)));
            await ev(`document.getElementById('xt-host').remove(); true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('team_cross_team_default_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
