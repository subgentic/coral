// Team settings > Messaging says whether a switch that is on is on by default or set (#11718, the page half of #11708): with cross_team_messaging_set and cross_team_artifacts_set false each switch has "On (default)" and a "Set on"
// button; the button stores the on explicitly (a PUT with just that switch, even though the value did not change, which the page used to skip) and the line then says "On"; an ordinary Save still sends only what changed. The route's
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
            const line = k => ev(`(() => { const e = document.querySelector('#xt-host .xt-set[data-for="${k}"]'); return e ? { text: e.textContent.replace(/\\s+/g, ' ').trim(), button: !!e.querySelector('button') } : null; })()`);
            let a = await line('cross_team_messaging'), f = await line('cross_team_artifacts');
            check(a && /^On \(default\)/.test(a.text) && a.button, at + 'messaging says "On (default)" with a Set on button: ' + JSON.stringify(a));
            check(f && /^On \(default\)/.test(f.text) && f.button, at + 'files says "On (default)" with a Set on button: ' + JSON.stringify(f));
            await shot(`messaging-default-${w}`);
            await ev(`document.querySelector('#xt-host button[data-act="set-on-messaging"]').click(); true`);
            await waitFor(`window.__puts.length === 1`, at + 'the messaging on is saved', 6000).catch(() => {});
            check(JSON.stringify(await ev(`window.__puts.map(b => Object.keys(b).filter(k => k !== 'subscriber_id'))`)) === JSON.stringify([['cross_team_messaging']]), at + 'Set on sends the messaging switch alone, though it did not change: ' + JSON.stringify(await ev(`window.__puts`)));
            await waitFor(`!!document.querySelector('#xt-host .xt-set[data-for="cross_team_messaging"]') && !document.querySelector('#xt-host .xt-set[data-for="cross_team_messaging"] button')`, at + 'the line follows', 6000).catch(() => {});
            a = await line('cross_team_messaging'); f = await line('cross_team_artifacts');
            check(a && a.text === 'On' && !a.button, at + 'messaging now says "On" with no button: ' + JSON.stringify(a));
            check(f && /^On \(default\)/.test(f.text), at + 'files is still "On (default)": ' + JSON.stringify(f));
            await ev(`document.querySelector('#xt-host button[data-act="set-on-files"]').click(); true`);
            await waitFor(`window.__puts.length === 2`, at + 'the files on is saved', 6000).catch(() => {});
            check(JSON.stringify(await ev(`window.__puts[1] ? Object.keys(window.__puts[1]).filter(k => k !== 'subscriber_id') : null`)) === JSON.stringify(['cross_team_artifacts']), at + 'Set on sends the files switch alone');
            await waitFor(`/^On$/.test((document.querySelector('#xt-host .xt-set[data-for="cross_team_artifacts"]') || {}).textContent || '')`, at + 'files says On', 6000).catch(() => {});
            // an ordinary change still sends only what changed
            await ev(`window.__view.set('cross_team_messaging', false); window.__view.save().then(() => true)`).catch(() => {});
            await waitFor(`window.__puts.length === 3`, at + 'the ordinary save', 6000).catch(() => {});
            check(JSON.stringify(await ev(`window.__puts[2] ? Object.keys(window.__puts[2]).filter(k => k !== 'subscriber_id') : null`)) === JSON.stringify(['cross_team_messaging']), at + 'an ordinary Save sends only the switch that changed: ' + JSON.stringify(await ev(`window.__puts[2]`)));
            await ev(`document.getElementById('xt-host').remove(); true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('team_cross_team_default_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
