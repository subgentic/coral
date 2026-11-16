// The "Share through Coral Hub" switch in Settings > Storage and cleanup (#16109), as a person sees it at 1280 and 390, light and dark: the row is in the Dropbox block, shown
// whether or not Dropbox is connected here, off by default, with the plain sentence under it; turning it on saves through its own route (PUT /api/cloud/hub-dropbox-share) and says
// so; a failed save puts the box back. The "before" shot is the same pane with the row taken out (what main shows). The server's answers are the page's fetch. Screenshots go to
// CORAL_SCREENSHOT_DIR. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await sleep(300); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const seen = id => ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return { why: 'missing' };
        if (el.closest('[hidden]')) return { why: 'inside [hidden]' };
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') return { why: 'no box' };
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { ok: !!at && (at === el || el.contains(at) || (el.labels && [...el.labels].some(l => l.contains(at)))), w: Math.round(r.width) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const theme of ['light', 'dark']) {
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
                const tag = `${w}px ${theme}`;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev);
                await ev(`(() => { const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
                    window.__puts = []; window.__putStatus = 200;
                    window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                        if (p === '/api/dropbox/status' && m === 'GET') return json({ app_key_set: true, connected: false, state: 'disconnected', hub_share: false });
                        if (p === '/api/cloud/hub-dropbox-share' && m === 'PUT') { window.__puts.push(JSON.parse(o.body)); return json({}, window.__putStatus); }
                        return real(u, o); };
                    return true; })()`);
                await ev(`window.showSettingsModal('cleanup'); true`);
                await waitFor(`!!document.getElementById('settings-pane-cleanup') && !document.getElementById('settings-pane-cleanup').hidden`, 'the Storage and cleanup page', 8000);
                await waitFor(`/Not connected/.test((document.getElementById('settings-dropbox-status') || {}).textContent || '')`, 'the Dropbox status', 8000);

                await ev(`document.getElementById('settings-dropbox-hubshare').hidden = true; true`);
                await seen('settings-dropbox');
                await shot(`hubshare-settings-before-${w}-${theme}`);
                await ev(`document.getElementById('settings-dropbox-hubshare').hidden = false; true`);

                const row = await seen('settings-dropbox-hubshare-on');
                check(`${tag}: the switch is shown with Dropbox not connected, and nothing covers it`, row.ok, JSON.stringify(row));
                check(`${tag}: it is off by default`, !(await ev(`document.getElementById('settings-dropbox-hubshare-on').checked`)));
                check(`${tag}: the sentence says private files are never sent and only on press Share`, await ev(`/Private files are never sent; a secret-looking one waits for your OK/.test(document.getElementById('settings-dropbox-hubshare-desc').textContent) && /Only when you press Share/.test(document.getElementById('settings-dropbox-hubshare-desc').textContent)`));
                check(`${tag}: no sideways scroll`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
                await shot(`hubshare-settings-after-${w}-${theme}`);

                await ev(`document.getElementById('settings-dropbox-hubshare-on').click(); true`);
                await waitFor(`/Saved\\. A file can go through Coral Hub/.test(document.getElementById('settings-dropbox-note').textContent)`, 'the saved sentence', 6000);
                check(`${tag}: turning it on saves through its own route`, (await ev(`JSON.stringify(window.__puts)`)) === JSON.stringify([{ allow: true }]));
                check(`${tag}: the box stays on`, await ev(`document.getElementById('settings-dropbox-hubshare-on').checked`));
                await ev(`window.__putStatus = 500; document.getElementById('settings-dropbox-hubshare-on').click(); true`);
                await waitFor(`/Not changed/.test(document.getElementById('settings-dropbox-note').textContent)`, 'the failed save', 6000);
                check(`${tag}: a failed save puts the box back`, await ev(`document.getElementById('settings-dropbox-hubshare-on').checked`));
            }
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Share through Coral Hub settings checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
