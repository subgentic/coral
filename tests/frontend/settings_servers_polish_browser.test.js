// Plain fixes from the Servers and Settings audit (#3981): (1) a checkbox in a Settings row is a box at the left of its column, not a
// full-width field with the tick centred in it (it sat detached from its label on a phone); (2) the Database encryption select shows
// its whole selected option; (3) a Servers row says what to do once, with the raw error behind Details. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { acrossGroups } = require('./helpers/settings_groups');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const SERVERS = [
        { id: 'local', label: 'studio-mac', local: true, status: 'online' },
        { id: 'm3', label: 'Old Laptop', url: 'http://192.168.1.50:8420', status: 'unreachable', last_seen: new Date(Date.now() - 86400000).toISOString(), last_error: 'dial tcp 192.168.1.50:8420: i/o timeout' },
        { id: 'm4', label: 'epoch', url: 'https://epoch.example.net:8420', status: 'unauthorized', last_seen: new Date().toISOString(), last_error: 'the server rejected the API key' },
        { id: 'm5', label: 'plain', url: 'http://plain.example:8420', status: 'online', last_error: 'warming up' },
    ];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
            if (p === '/api/health') return Promise.resolve(new Response(JSON.stringify({ status: 'ok', hub: true, version: '1.4.64' }), { status: 200 }));
            if (p === '/api/servers' && (o.method || 'GET') === 'GET') return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(SERVERS)}), { status: 200 }));
            return R(u, o); }; })();` });
        for (const [dev, w, h, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            // 1 and 2: Settings
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'modals.js'); await m.showSettingsModal(); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'settings');
            await sleep(500); // sleep-ok: the dialog's rows fill from several answers; there is no single completion event
            const boxes = await acrossGroups(ev, `[...document.querySelectorAll('#settings-modal .info-grid dd input[type="checkbox"], #settings-modal input.switch')].filter(i => i.getClientRects().length).map(i => { const dd = i.closest('dd, .sv-control').getBoundingClientRect(), r = i.getBoundingClientRect(); return { id: i.id, w: Math.round(r.width), offset: Math.round(r.left - dd.left) }; })`);
            assert.ok(boxes.length >= 3, dev + ': the dialog has checkbox rows to check (' + boxes.length + ')');
            // A checkbox is a box (a 2.5rem switch since #4566), never the full-width field of #3981.
            assert.deepEqual(boxes.filter(b => b.w > 44), [], dev + ': every checkbox is a small switch, not a full-width box: ' + JSON.stringify(boxes.filter(b => b.w > 44)));
            await ev(`document.getElementById('settings-tab-security')?.click(); document.getElementById('settings-group-select') && true`);
            await ev(`const e = document.getElementById('settings-database-encryption'); e.dataset.unsupported = ''; e.closest('.settings-row, .sv-row').hidden = false; true`); // a standard build has no encryption and hides the row (#5589); this checks the select's width where it is shown
            const sel = await ev(`(() => { const s = document.getElementById('settings-database-encryption'); const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(s); c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; const text = s.options[s.selectedIndex].text; return { text, need: Math.ceil(c.measureText(text).width) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 22, have: Math.floor(s.getBoundingClientRect().width) }; })()`);
            assert.ok(sel.need <= sel.have, `${dev}: the Database encryption select shows "${sel.text}" whole (needs ${sel.need} px, has ${sel.have})`);
            assert.equal(sel.text, 'Off (plaintext database)');
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
            // 3: Servers
            await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); s.state.hub = true; s.state.servers = ${JSON.stringify(SERVERS)}; const t = await import((window.__coralStatic || '/static/') + 'servers_tab.js'); t.updateServersTabVisibility(); return true; })()`);
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`!!document.querySelector('#server-row-m3')`, 'the servers list');
            const rows = await ev(`(async () => { const until = async f => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 20)); }; const out = {}; for (const id of ['m3', 'm4', 'm5']) { document.querySelector('#server-row-' + id + ' [data-action=open]').click(); await until(() => document.querySelector('.servers-page')); const r = document.querySelector('.servers-page'); const lines = [...r.querySelectorAll('.servers-row-error')]; out[id] = { lines: lines.map(l => l.firstChild.textContent.trim()), details: [...r.querySelectorAll('details')].map(d => d.textContent.replace('Details', '').trim()), text: r.textContent }; document.getElementById('servers-back').click(); await until(() => document.querySelector('table.servers-table')); } return out; })()`); // a server's page (#7638)
            assert.deepEqual(rows.m3.lines, ['Is Coral running on that machine? Check the URL.'], dev + ': one line for an unreachable server');
            assert.deepEqual(rows.m3.details, ['dial tcp 192.168.1.50:8420: i/o timeout'], 'with the raw error behind Details');
            assert.equal(rows.m4.lines.length, 1, dev + ': one line for a rejected key, not the raw text and the hint');
            assert.match(rows.m4.lines[0], /rejected the stored API key/); assert.deepEqual(rows.m4.details, ['the server rejected the API key']);
            assert.deepEqual(rows.m5.lines, ['warming up'], 'an error with no hint is shown as it is'); assert.deepEqual(rows.m5.details, []);
            // 4: the Add server form in the tab looks like the dialogs' forms (#4324): a label above a full-width field, fields stacked and aligned, touch-size on a phone.
            await ev(`document.querySelector('[data-action=add]').click(); true`);
            await waitFor(`!!document.getElementById('servers-form')`, 'the add form');
            const form = await ev(`(() => { const f = document.getElementById('servers-form'); const fr = f.querySelector('.sv-form').getBoundingClientRect(); const px = v => Math.round(v * 10) / 10;
                const fields = ['id', 'label', 'url', 'key'].map(n => { const i = document.getElementById('servers-' + n); const r = i.getBoundingClientRect(); const lr = document.querySelector('label[for=servers-' + n + ']').getBoundingClientRect();
                    return { n, w: px(r.width), left: px(r.left - fr.left), above: r.top >= lr.bottom - 1, h: px(r.height) }; });
                const sw = document.getElementById('servers-private'); const hit = (sw.closest('.sv-row') || sw).getBoundingClientRect(); const btns = [...f.querySelectorAll('.sv-bar .btn')].map(b => px(b.getBoundingClientRect().height));
                return { formW: px(fr.width), fields, rowH: px(hit.height), btns, over: document.documentElement.scrollWidth - innerWidth }; })()`);
            for (const f of form.fields) {
                assert.ok(f.w >= form.formW - 6, `${dev}: ${f.n} takes the form's width (${f.w} of ${form.formW})`);
                assert.ok(Math.abs(f.left) <= 2, `${dev}: ${f.n} starts at the form's left edge (${f.left})`);
                assert.ok(f.above, `${dev}: ${f.n}'s label sits above it`);
                assert.ok(f.h >= (mobile ? 44 : 32), `${dev}: ${f.n} is ${f.h} px tall`);
            }
            if (mobile) assert.ok(form.rowH >= 44 && form.btns.every(h => h >= 44), `${dev}: the switch row (${form.rowH}) and the buttons (${form.btns}) are 44 px targets`);
            assert.ok(form.over <= 0, `${dev}: the form adds no sideways scroll (${form.over})`);
            await ev(`[...document.querySelectorAll('#servers-form .sv-bar .btn')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
            await ev(`window.switchNavTab('agents'); true`);
        }
        console.log('PASS settings and servers polish: checkboxes are boxes, the encryption select fits, one error line per server, the add form is labels above full-width fields');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
