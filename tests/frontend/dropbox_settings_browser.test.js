// The Dropbox block in Settings > Storage and cleanup (#14609, found on the Operator's walk, #14714): it was written inside the hidden
// #settings-cleanup-live holder and nothing drew it into a row, so a person never saw it while the jsdom tests passed. This suite opens the real
// Settings page in Chrome at 1280 and 390 px and checks, as a person sees it: the block and Connect are shown (no [hidden] ancestor, a real box,
// on screen once scrolled to), Connect is the element at its own centre (nothing covers it), and a click on it asks the server to connect. Then,
// connected, the backup part is shown. The server's Dropbox answers are the page's fetch. Drives Chrome over CDP through agent_view_harness.js
// against the isolated dev server.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await sleep(300); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // seen: shown, with a box, inside the viewport once scrolled to, and the element at its centre is itself (or inside it).
    const seen = id => ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return { why: 'missing' };
        if (el.closest('[hidden]')) return { why: 'inside [hidden]: ' + (el.closest('[hidden]').id || el.closest('[hidden]').tagName) };
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') return { why: 'no box', w: r.width, h: r.height };
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return { why: 'off screen', top: r.top, left: r.left };
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { ok: !!at && (at === el || el.contains(at)), at: at ? (at.id || at.className || at.tagName) : null, w: Math.round(r.width) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
                window.__dbx = { app_key_set: true, connected: false, state: 'disconnected' }; window.__connects = 0; window.__opened = [];
                window.open = (u) => { window.__opened.push(String(u)); return {}; };
                window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                    if (p === '/api/dropbox/status' && m === 'GET') return json(window.__dbx);
                    if (p === '/api/dropbox/connect' && m === 'POST') { window.__connects++; return json({ authorize_url: 'https://www.dropbox.com/oauth2/authorize?client_id=test' }); }
                    return real(u, o); };
                return true; })()`);
            await ev(`window.showSettingsModal('cleanup'); true`);
            await waitFor(`!!document.getElementById('settings-pane-cleanup') && !document.getElementById('settings-pane-cleanup').hidden`, 'the Storage and cleanup page (the dialog loads lazily)', 8000);
            await waitFor(`/Not connected/.test((document.getElementById('settings-dropbox-status') || {}).textContent || '')`, 'the Dropbox status to be read', 8000);

            console.log(`${tag}: not connected`);
            const block = await seen('settings-dropbox');
            check(`${tag}: the Dropbox block is shown in Storage and cleanup (not inside a hidden holder)`, block.ok, JSON.stringify(block));
            check(`${tag}: it sits in its own row of the page`, await ev(`!!document.getElementById('settings-dropbox').closest('#settings-dropbox-row') && !!document.getElementById('settings-dropbox').closest('#settings-pane-cleanup')`));
            const conn = await seen('settings-dropbox-connect');
            check(`${tag}: Connect is shown and nothing covers it`, conn.ok, JSON.stringify(conn));
            await shot(`dropbox-settings-${w}`);
            await ev(`document.getElementById('settings-dropbox-connect').click(); true`);
            await waitFor(`window.__connects > 0`, 'the connect request', 6000);
            check(`${tag}: a click on Connect asks this Coral to connect`, (await ev(`window.__connects`)) === 1);

            console.log(`${tag}: connected`);
            await ev(`window.__dbx = { app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', backup: { backed_up: 4 }, filters: { types: [], max_age_days: 0 }, retention: { days: 0 } };
                import((window.__coralStatic || '/static/') + 'dropbox_settings.js').then(m => m.loadDropbox()).then(() => true)`);
            await waitFor(`/Connected/.test(document.getElementById('settings-dropbox-status').textContent)`, 'the connected status', 6000);
            const backup = await seen('settings-dropbox-backup');
            check(`${tag}: connected, the backup part (counts, types, age, retention) is shown`, backup.ok, JSON.stringify(backup));
            const disc = await seen('settings-dropbox-disconnect');
            check(`${tag}: Disconnect is shown and nothing covers it`, disc.ok, JSON.stringify(disc));
            check(`${tag}: no sideways scroll`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-settings-connected-${w}`);
            console.log(`${tag}: the layout (#14736, the Operator's shot)`);
            const lay = await ev(`(() => { const box = r => ({ t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) });
                const pairs = [...document.querySelectorAll('#settings-dropbox-types label')].map(l => { const i = l.querySelector('input'), t = box(l.getBoundingClientRect()), c = box(i.getBoundingClientRect()); return { h: t.h, gap: t.r - c.r, sameLine: Math.abs((c.t + c.b) / 2 - (t.t + t.b) / 2) < 8, boxFirst: c.l <= t.l + 2 }; });
                const tops = new Set([...document.querySelectorAll('#settings-dropbox-types label')].map(l => Math.round(l.getBoundingClientRect().top)));
                const fs = getComputedStyle(document.querySelector('#settings-dropbox .settings-dropbox-filters'));
                const age = document.getElementById('settings-dropbox-age').getBoundingClientRect(), ageLabel = document.querySelector('label[for="settings-dropbox-age"]').getBoundingClientRect();
                const pane = document.getElementById('settings-dropbox').getBoundingClientRect();
                return { pairs, rows: tops.size, border: fs.borderTopWidth, ageW: Math.round(age.width), ageInPane: age.left >= pane.left - 1 && age.right <= pane.right + 1, ageBesideLabel: age.top < ageLabel.bottom + 2 }; })()`);
            check(`${tag}: each type's box comes first and sits on the same line as its name, close to it`, lay.pairs.length === 10 && lay.pairs.every(p => p.sameLine && p.boxFirst && p.h < 40), JSON.stringify(lay.pairs.slice(0, 3)));
            check(`${tag}: the ten types fit in a compact grid (at most ${w > 600 ? 2 : 5} rows)`, lay.rows <= (w > 600 ? 2 : 5), String(lay.rows));
            check(`${tag}: no box drawn round the sections`, lay.border === '0px', lay.border);
            check(`${tag}: the age field is a small box in the page${w > 600 ? ', on the line of its label' : ''}`, lay.ageW < 140 && lay.ageInPane && (w <= 600 || lay.ageBesideLabel), JSON.stringify(lay));
            await shot(`dropbox-settings-layout-${w}`);
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Dropbox settings checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
