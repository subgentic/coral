// The Messaging switches say the same on Team settings and on New team step 3, one state each (#11788, the v2.0.24 walk: the saved team showed "On (default)" with "Set on" and "Message teams here: off" under a switch that was on, and New team
// showed both switches off while a team launched with no change acts as on): both screens draw the same two switches, on, with the same words, no "(default)", and the same line about teams on this computer (not allowed yet; on the
// saved page it has Allow). Launching with no change stores nothing for them. 1280 and 390. The board's settings are stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`, TEAM = 'xt11788';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // what a screen says about the two switches: their labels, whether each is on, their help lines, and the line about this computer
    const read = host => ev(`(() => { const h = document.querySelector(${JSON.stringify(host)}), sw = k => h.querySelector('[name="' + k + '"]'), words = k => { const i = sw(k); if (!i) return null; return { label: ((document.getElementById(i.getAttribute('aria-labelledby') || '') || {}).textContent || '').trim(), on: i.checked, help: ((i.getAttribute('aria-describedby') || '').split(' ').map(id => (document.getElementById(id) || {}).textContent || '').join(' ')).replace(/\\\\s+/g, ' ').trim() }; };
        const line = h.querySelector('.xt-reach-here'); return { m: words('cross_team_messaging'), f: words('cross_team_artifacts'), here: line ? line.textContent.replace(/\\\\s+/g, ' ').trim() : null, text: h.textContent }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const real = window.fetch, s = { cross_team_messaging: true, cross_team_artifacts: true, cross_team_messaging_set: false, cross_team_artifacts_set: false };
                window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin).pathname, m = (o.method || 'GET').toUpperCase(); const json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'content-type': 'application/json' } }));
                    if (p === '/api/board/${TEAM}/settings' && m === 'GET') return json(s);
                    if (p === '/api/board/${TEAM}/cross-team-state') return json({ error: 'none' }, 404);
                    return real(u, o); }; window.__s = s; return true; })()`);
            // the saved team
            await ev(`(async () => { const host = document.createElement('div'); host.id = 'saved-host'; host.style.cssText = 'padding:16px;max-width:640px'; document.body.prepend(host); const { mountMessaging } = await import(${S} + 'team_cross_team_fields.js'); await mountMessaging(host, '${TEAM}', { settings: { ...window.__s }, state: null }); return true; })()`);
            await waitFor(`!!document.querySelector('#saved-host [name="cross_team_messaging"]')`, at + 'Team settings draws the switches', 8000);
            const saved = await read('#saved-host');
            await shot(`messaging-saved-${w}`);
            await ev(`document.getElementById('saved-host').remove(); true`);
            // New team step 3
            await ev(`(async () => { const host = document.createElement('div'); host.id = 'team-start-host'; host.style.cssText = 'padding:16px;max-width:760px'; document.body.prepend(host); const m = await import(${S} + 'team_launch_settings.js'); m.mountTeamLaunchSettings(); return true; })()`);
            await waitFor(`!!document.querySelector('#team-start-host [name="cross_team_messaging"]')`, at + 'New team step 3 draws the switches', 8000);
            await ev(`(() => { const host = document.getElementById('team-start-host'), t = [...host.querySelectorAll('[role=tab]')].find(x => /Messaging/.test(x.textContent)); if (t) { t.click(); return true; } const s = host.querySelector('select'); if (s) { const o = [...s.options].find(x => /Messaging/.test(x.textContent)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } } return true; })()`);
            await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: the pane opens
            const fresh = await read('#team-start-host');
            await shot(`messaging-new-team-${w}`);
            for (const [name, r] of [['Team settings', saved], ['New team step 3', fresh]]) {
                check(r.m && r.f && r.m.label === 'Message teams on other computers' && r.f.label === 'Share files with teams on other computers' && r.m.on && r.f.on, at + `${name}: both switches read on, as a send finds them: ${JSON.stringify([r.m && r.m.on, r.f && r.f.on])}`);
                check(!/\(default\)|Set on|Message teams here/.test(r.text), at + `${name}: one state per switch, no "(default)", "Set on" or "Message teams here"`);
                check(/^Teams on this computer: not allowed yet\./.test(r.here || ''), at + `${name}: the line about teams on this computer: ${JSON.stringify(r.here)}`);
            }
            check(JSON.stringify([saved.m && saved.m.label, saved.f && saved.f.label, saved.m && saved.m.help, saved.f && saved.f.help]) === JSON.stringify([fresh.m && fresh.m.label, fresh.f && fresh.f.label, fresh.m && fresh.m.help, fresh.f && fresh.f.help]), at + `both screens say the same about each switch: ${JSON.stringify([saved.m, fresh.m])}`);
            check(/ Allow$/.test(saved.here || '') && !/ Allow$/.test(fresh.here || '') && /once the team has started\.$/.test(fresh.here || ''), at + 'the saved page has Allow; the new team says to allow it in settings once the team has started');
            await ev(`document.getElementById('team-start-host').remove(); true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('messaging_same_screens_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
