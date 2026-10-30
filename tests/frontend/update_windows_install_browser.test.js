// Install update on Windows (#7338, UI Accessibility's #7335): the server answers relaunch.reason local_approval_needed there (and local_install: true only to this computer's own dashboard), and the page
// must offer Install update, wired to POST /api/system/update/install with the version it showed. Against a stub of the status and install routes (no install ever happens): the control and Settings say
// Install update and are enabled; the dialog says Windows asks for permission; the click sends {version} and never a relaunch; a stale_version answer redraws for what is ready now and sends the new version;
// a request through Coral Hub (no local_install) draws no button; an unavailable button is a real disabled one; an unknown reason has a sentence; the Windows Settings sentences are right.
// Desktop and a 390 px phone. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const agents = [{ session_id: 'sid-0', name: 'api-worker', state: 'working' }, { session_id: 'sid-1', name: 'review-1', state: 'waiting' }];
const win = (version, over = {}, relaunch = {}) => ({ enabled: true, relaunch_available: true, installed: '1.4.125', state: 'staged', staged: { version, staged_at: '2026-10-17T03:00:00Z', days_ready: 1, verified: true }, local_install: true,
    relaunch: { available: false, reason: 'local_approval_needed', restarts: agents, ack: '', ...relaunch }, last_result: null, checked_at: new Date().toISOString(), auto: true, install_kind: 'msi', ...over });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const fs = require('node:fs'), path = require('node:path');
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name.replace(/[^a-z0-9-]+/gi, '-') + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const settle = (ms, quietMs = 120) => require('./helpers/wait').settle(ev, ms, quietMs);
    const STUB = `(() => {
        const real = window.fetch;
        window.__upd = { status: null, calls: [], install: { status: 202, body: { ok: true, quitting: true } }, hubOn: true };
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/cloud/status')) return json({ state: 'connected', configured: true, url: 'https://hub.example.invalid', max_mode: 'launch', mode: 'launch', hub_relaunch_updates: window.__upd.hubOn, hub_relaunch_available: window.__upd.hubAvail !== false, hub_relaunch_needs_here: !!(window.__upd.status && window.__upd.status.local_install) });
            if (url.includes('/api/system/update')) {
                const path = url.replace(/^.*\\/api\\/system\\/update/, '') || '/status';
                window.__upd.calls.push({ method, path, body: o && o.body ? JSON.parse(o.body) : null });
                if (path === '/status') return window.__upd.status ? json(window.__upd.status) : json({ error: 'none' }, 404);
                if (path === '/install') { const r = window.__upd.install; if (r.then) { const x = r.then; window.__upd.install = { status: 202, body: { ok: true } }; return x(); } return json(r.body, r.status); }
                if (path === '/check') return json({ ok: true });
                return json({ error: 'unexpected route' }, 500);
            }
            return real(u, o);
        };
        return true; })()`;
    const load = async (view, status) => {
        await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
        await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await ev(`localStorage.clear(); true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').coralReady(ev);
        await ev(`import(${S} + 'update_flag.js').then(m => { m.setUpdatesEnabled(true); return true; })`);
        await ev(STUB);
        await setStatus(status);
    };
    const setStatus = async (st) => { await ev(`window.__upd.status = ${JSON.stringify(st)}; import(${S} + 'update_ui.js').then(m => m.startUpdateUi && m.startUpdateUi()).then(() => import(${S} + 'update_ui.js')).then(m => m.refreshUpdateStatus()).then(() => true)`); await settle(150); };
    const pill = () => ev(`(() => { const p = document.getElementById('update-pill'); if (!p) return null; const r = p.getBoundingClientRect(); return { hidden: p.hidden || r.width === 0, name: p.getAttribute('aria-label'), ariaDisabled: p.getAttribute('aria-disabled'), text: [...p.querySelectorAll('span')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.textContent).join('').replace(/\\s+/g, ' ').trim() }; })()`);
    const pane = async () => { await ev(`window.showSettingsModal('updates'); import(${S} + 'update_settings.js').then(m => m.showUpdatesPane()).then(() => true)`); await settle(250);
        return ev(`(() => { const b = document.getElementById('update-pane-body'); const act = b.querySelector('.update-act'); return { text: b.textContent.replace(/\\s+/g, ' ').trim(), act: act ? { text: act.textContent.trim(), disabled: act.disabled, ariaDisabled: act.getAttribute('aria-disabled'), primary: act.classList.contains('btn-primary') } : null, hubButton: [...b.querySelectorAll('button')].some(x => /Change in Network and Hub/.test(x.textContent)) }; })()`); };
    const dialog = () => ev(`(() => { const d = document.getElementById('update-confirm-modal'); if (!d || getComputedStyle(d).display === 'none') return null; return { title: (document.getElementById('update-confirm-title') || {}).textContent, text: d.textContent.replace(/\\s+/g, ' ').trim(), go: (d.querySelector('.update-go') || {}).textContent }; })()`);
    const calls = () => ev(`JSON.stringify(window.__upd.calls.filter(c => c.path !== '/status'))`).then(JSON.parse);

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const view of [{ name: 'desktop', w: 1280, h: 900, phone: false }, { name: '390px', w: 390, h: 844, phone: true }]) {
            const tag = view.name; console.log(tag);

            // ═══ this computer's own dashboard on Windows: Install update, enabled
            await load(view, win('1.4.126'));
            let p = await pill();
            check(`${tag}: the control says Install update, names the version, and is not drawn as unavailable (${p && p.name})`, p && !p.hidden && /^Install update to version 1\.4\.126/.test(p.name) && p.ariaDisabled === 'false' && /^Install update/.test(p.text) && !/Relaunch/.test(p.name + p.text) && !/Not available/.test(p.name));
            let pn = await pane();
            check(`${tag}: Settings has an enabled primary Install update, and no "Not available right now" (${JSON.stringify(pn.act)})`, pn.act && pn.act.text === 'Install update' && pn.act.disabled === false && pn.act.primary && !/Not available right now/.test(pn.text));
            check(`${tag}: Settings says Windows asks first, not that it installs on relaunch; Coral Hub cannot install, and there is no switch to change (${pn.text.slice(0, 400)})`, /Windows asks for your permission/.test(pn.text) && !/installs when you relaunch/i.test(pn.text) && /Not on Windows/.test(pn.text) && !/without anyone here saying yes/.test(pn.text) && pn.hubButton === false);
            await ev(`window.hideSettingsModal(); true`);

            // the dialog, and what the click sends
            await ev(`document.getElementById('update-pill').click(); true`); await settle(300);
            let d = await dialog();
            check(`${tag}: the dialog is about installing, says Windows asks for permission, and offers Install (${JSON.stringify(d && { t: d.title, go: d.go })})`, d && d.title === 'Install Coral 1.4.126?' && /Windows asks for your permission/.test(d.text) && /Install update, restart 2 agents/.test(d.go) && !/relaunch\?/i.test(d.title));
            await ev(`document.querySelector('#update-confirm-modal .update-go').click(); true`); await settle(300);
            let c = await calls();
            check(`${tag}: the click sent POST /install with the version the dialog showed, and nothing to a relaunch route (${JSON.stringify(c)})`, c.length === 1 && c[0].method === 'POST' && c[0].path === '/install' && JSON.stringify(c[0].body) === '{"version":"1.4.126"}');
            d = await dialog();
            check(`${tag}: after the answer the dialog says Windows will ask and Coral starts again (${d && d.text.slice(-160)})`, d && /Windows will ask for your permission/.test(d.text));

            // ═══ the staged update changed while the dialog was open: 409 stale_version redraws for what is ready now, and the next click sends the new version
            await load(view, win('1.4.126'));
            await ev(`window.__upd.install = { status: 409, body: { code: 'stale_version' } }; document.getElementById('update-pill').click(); true`); await settle(300);
            await ev(`window.__upd.status = ${JSON.stringify(win('1.4.127'))}; document.querySelector('#update-confirm-modal .update-go').click(); true`); await settle(500);
            d = await dialog();
            check(`${tag}: a stale answer redraws the dialog for 1.4.127, with the sentence, and installed nothing (${JSON.stringify(d && { t: d.title, said: /changed since this page showed it/.test(d.text) })})`, d && d.title === 'Install Coral 1.4.127?' && /changed since this page showed it/.test(d.text));
            await ev(`window.__upd.install = { status: 202, body: { ok: true } }; document.querySelector('#update-confirm-modal .update-go').click(); true`); await settle(300);
            c = await calls();
            check(`${tag}: the second click sent 1.4.127 (${JSON.stringify(c.map(x => x.body))})`, c.length === 2 && JSON.stringify(c[1].body) === '{"version":"1.4.127"}');

            // ═══ a request through Coral Hub (no local_install): nobody there can install, so no button anywhere
            await load(view, win('1.4.126', { local_install: undefined }));
            p = await pill(); pn = await pane();
            check(`${tag}: through Coral Hub there is no control in the top bar and no Install update in Settings (${p && p.hidden}, ${JSON.stringify(pn.act)})`, p && p.hidden && (!pn.act || !/Install update|Relaunch/.test(pn.act.text)));
            await ev(`window.hideSettingsModal(); true`);

            // ═══ an unavailable button is a real disabled button, and the reason is a sentence
            await load(view, win('1.4.126', { local_install: undefined }, { reason: 'busy', restarts: [] }));
            p = await pill(); pn = await pane();
            check(`${tag}: busy: the control says why and is drawn unavailable (${p && p.name})`, p && !p.hidden && p.ariaDisabled === 'true' && /Not available right now: Another relaunch is already running\./.test(p.name));
            check(`${tag}: busy: Settings has a disabled Update and relaunch, not an enabled primary (${JSON.stringify(pn.act)})`, pn.act && pn.act.text === 'Update and relaunch' && pn.act.disabled === true);
            const look = await ev(`(() => { const b = document.querySelector('#update-pane-body .update-act'); const cs = getComputedStyle(b); return { opacity: Number(cs.opacity), cursor: cs.cursor }; })()`);
            check(`${tag}: busy: the disabled button looks disabled: faded, not-allowed cursor (${JSON.stringify(look)})`, look.opacity <= 0.6 && look.cursor === 'not-allowed');
            await shot(`${tag} settings disabled install`);
            await ev(`window.hideSettingsModal(); true`);
            await load(view, win('1.4.126', { local_install: undefined }, { reason: 'a_reason_nobody_knows', restarts: [] }));
            p = await pill(); pn = await pane();
            check(`${tag}: an unknown reason says Coral did not say why, never just "Unavailable" (${p && p.name})`, p && /Coral did not say why\. Nothing was changed\./.test(p.name) && !/Unavailable/.test(p.name) && /Coral did not say why/.test(pn.text) && !/Unavailable/.test(pn.text));
            await ev(`window.hideSettingsModal(); true`);

            // ═══ #7343: a build without the Hub's relaunch feature (every shipping build): the status says relaunch_available is false, so Settings draws no Hub row (the automatic switch stays: Coral checks by itself in every build),
            // the Network and Hub pane draws no switch or sentence for it, and Install update is still there
            await load(view, win('1.4.126', { relaunch_available: false }));
            await ev(`window.__upd.hubAvail = false; true`);
            pn = await ev(`(async () => { window.showSettingsModal('updates'); const m = await import(${S} + 'update_settings.js'); await m.showUpdatesPane(); const b = document.getElementById('update-pane-body'); const act = b.querySelector('.update-act'); return { text: b.textContent.replace(/\\s+/g, ' ').trim(), auto: !!document.getElementById('settings-update-auto'), act: act ? act.textContent.trim() : null }; })()`);
            check(`${tag}: without the Hub's feature Settings > Updates has no Coral Hub row, keeps the automatic switch, and still has Install update (${JSON.stringify({ auto: pn.auto, act: pn.act, hub: /Relaunch from Coral Hub/.test(pn.text) })})`, pn.auto === true && !/Relaunch from Coral Hub|Coral Hub can|Not on Windows/.test(pn.text) && pn.act === 'Install update');
            await ev(`window.hideSettingsModal(); true`);
            for (const [avail, want] of [[false, false], [true, true]]) {
                await ev(`window.__upd.hubAvail = ${avail}; window.showSettingsModal('network'); true`); await settle(500);
                await ev(`import(${S} + 'cloud_connect.js').then(m => m.loadCloudStatus()).then(() => true)`);
                await waitFor(`(() => { const r = document.getElementById('settings-cloud-hub-relaunch-row'); return !!r && r.hidden === ${!avail}; })()`, `the Hub relaunch row ${avail ? 'drawn' : 'hidden'}`, 8000); await settle(150);
                const net = await ev(`(() => { const row = document.getElementById('settings-cloud-hub-relaunch-row'), st = document.getElementById('settings-cloud-hub-relaunch-state'); const vis = e => !!e && !e.hidden && e.getClientRects().length > 0; return { row: vis(row), state: vis(st), exists: !!row }; })()`);
                check(`${tag}: Network and Hub with the Hub's feature ${avail ? 'on' : 'off'}: the relaunch switch and its sentence are ${want ? 'drawn' : 'not drawn'} (${JSON.stringify(net)})`, net.exists && net.row === want && (want ? true : net.state === false));
            }
            await ev(`window.hideSettingsModal(); true`);

            // ═══ elsewhere nothing changed: a relaunch the server offers is still Update and relaunch
            await load(view, win('1.4.126', { local_install: undefined }, { available: true, reason: '', ack: 'tok' }));
            p = await pill(); pn = await pane();
            check(`${tag}: a relaunch the server offers is still "Update and relaunch", enabled (${p && p.text}; ${JSON.stringify(pn.act)})`, p && /^Update and relaunch/.test(p.text) && p.ariaDisabled === 'false' && pn.act && pn.act.text === 'Update and relaunch' && pn.act.disabled === false);
            await ev(`window.hideSettingsModal(); true`);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close();
        process.exit(failed ? 1 : 0);
    } catch (e) {
        console.error('FAIL', e && e.stack || e);
        await client.close().catch(() => {});
        process.exit(1);
    }
})();
