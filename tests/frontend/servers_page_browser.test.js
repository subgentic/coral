// The Servers tab of a self-hosted hub as a table and a server's page (#7638, UI/UX's 170 item 6): the registry is a table (Server, Status,
// Agents) with the name as the button that opens the server's page; the page has its facts and Test, Edit and Remove in a bar pinned at its
// foot (Remove the danger button, its confirmation in the bar), a text link back, and no buttons in the table rows. 1280 and 390 px.
// SHOT_DIR=<dir> saves screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { oneLinePerRow } = require('./helpers/row_lines');
const { setTheme } = require('./helpers/contrast');

const SERVERS = [
    { id: 'local', label: 'studio-mac', local: true, status: 'online' },
    { id: 'epoch', label: 'epoch', url: 'https://epoch.example.net:8420', status: 'online' },
    { id: 'lan', label: 'LAN box', url: 'http://192.168.1.50:8420', status: 'unreachable', last_error: 'dial tcp: i/o timeout', allow_private: true, last_seen: '2026-10-13T00:00:00Z' },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const ok = name => console.log(`   ✓ ${name}`);
    const sceneShot = require('./helpers/scene_shots')(Page, 'automations-servers');
    const shot = async n => { if (process.env.SHOT_DIR) fs.writeFileSync(`${process.env.SHOT_DIR}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.__calls = []; window.__list = ${JSON.stringify(SERVERS)};
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname; const m = (o.method || 'GET').toUpperCase();
                const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/health') return json(200, { status: 'ok', hub: true, version: '1.4.75' });
                if (p === '/api/servers' && m === 'GET') return json(200, window.__list);
                const t = p.match(/^\\/api\\/servers\\/([^/]+)(\\/test)?$/);
                if (t && t[2] && m === 'POST') { window.__calls.push('test ' + t[1]); return json(200, { id: t[1], label: t[1], status: 'online' }); }
                if (t && m === 'DELETE') { window.__calls.push('delete ' + t[1]); window.__list = window.__list.filter(s => s.id !== t[1]); return json(200, {}); }
                return R(u, o); }; })();` });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); s.state.hub = true; s.state.servers = ${JSON.stringify(SERVERS)}; return true; })()`);
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`!!document.querySelector('#server-row-lan')`, 'the servers table');

            // 1. a table: Server, Status, Agents; the name opens the page; no Test, Edit or Remove in the rows
            const t = await ev(`(() => { const tb = document.querySelector('table.dt-table'); return { heads: [...tb.querySelectorAll('thead th')].map(h => (h.querySelector('.dt-sort span') || h.querySelector('.dt-head-text')).textContent.trim()), scopes: [...tb.querySelectorAll('thead th')].map(h => h.getAttribute('scope')), rows: tb.querySelectorAll('tbody tr').length,
                links: [...tb.querySelectorAll('tbody [data-action=open]')].map(b => b.textContent.trim()), rowButtons: [...tb.querySelectorAll('tbody button')].filter(b => b.dataset.action !== 'open').length, overflow: document.documentElement.scrollWidth - innerWidth }; })()`);
            assert.deepEqual(t.heads, ['Server', 'Tags', 'Version', 'Status', 'Agents'], at + 'the columns (one line a row, Goal #79)');
            assert.equal(await ev(`document.getElementById('servers-tab-title').checkVisibility()`), true, at + 'the table keeps the Servers title');
            assert.deepEqual(t.scopes, ['col', 'col', 'col', 'col', 'col']);
            await oneLinePerRow(ev, 'table.dt-table tbody tr[data-key]', `${at}the servers`, assert, { min: 2 }); // Goal #79: a server is one line at both widths; a narrow list drops Tags, Version and Agents
            for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await sceneShot(`servers-list-${theme}-${w}`); } await setTheme(ev, 'dark'); // the scenes UI/UX looks at (written when the gate asks for shots)
            assert.equal(t.rows, 3, at + 'this hub and two servers');
            assert.deepEqual(t.links, ['epoch', 'LAN box'], at + 'each remote server\'s name opens its page; this hub has none');
            assert.equal(t.rowButtons, 0, at + 'no Test, Edit or Remove buttons in the table');
            assert.ok(t.overflow <= 0, at + 'no sideways scroll');
            await shot(`servers-table-${w}`);
            ok(at + 'the table: Server, Status, Agents, the name as the button');

            // 2. a server's page
            await ev(`document.querySelector('#server-row-lan [data-action=open]').click(); true`);
            await waitFor(`!!document.getElementById('servers-page-name')`, 'the page');
            const p = await ev(`(() => { const bar = document.querySelector('.servers-page .item-bar'), view = document.getElementById('servers-view'); const b = [...bar.querySelectorAll('button')]; const r = bar.getBoundingClientRect(), v = view.getBoundingClientRect();
                return { name: document.getElementById('servers-page-name').textContent.replace(/\\s+/g, ' ').trim(), back: document.getElementById('servers-back').textContent.trim(), focus: document.activeElement.id, buttons: b.map(x => x.textContent.trim()), remove: b.find(x => x.dataset.action === 'delete').classList.contains('btn-danger'), small: b.some(x => x.classList.contains('btn-small')), barBottomGap: Math.round(v.bottom - r.bottom),
                    facts: Object.fromEntries([...document.querySelectorAll('.servers-fact')].map(f => [f.querySelector('dt').textContent, f.querySelector('dd').textContent.replace(/\\s+/g, ' ').trim()])), error: (document.querySelector('.servers-row-error') || {}).textContent, table: !!document.querySelector('.servers-table'), overflow: document.documentElement.scrollWidth - innerWidth }; })()`);
            assert.match(p.name, /^LAN box lan/, at + 'the name and id');
            assert.equal(p.back, '← Servers');
            assert.equal(p.focus, 'servers-back', at + 'the focus goes to the way back');
            assert.deepEqual(p.buttons, ['Test', 'Edit', 'Remove'], at + 'the bar');
            assert.equal(p.remove, true, at + 'Remove is the danger button');
            assert.equal(p.small, false, at + 'the normal button size');
            assert.ok(p.barBottomGap <= 1, at + 'the bar is at the foot of the page: ' + p.barBottomGap);
            assert.equal(p.facts.URL, 'http://192.168.1.50:8420'); assert.match(p.facts['Last contact'] || '', /\S/, at + 'last contact, as it is not online'); assert.equal(p.facts.Agents, '0 agents');
            assert.match(p.error || '', /Is Coral running on that machine/, at + 'what to do about it');
            assert.equal(p.table, false, at + 'the table is not on the page');
            assert.equal(await ev(`document.getElementById('servers-tab-title').checkVisibility()`), false, at + 'the page has no "Servers" title: its back link says it');
            assert.ok(p.overflow <= 0, at + 'no sideways scroll');
            await shot(`servers-page-${w}`);
            ok(at + 'the page: facts, a way back, Test, Edit and Remove pinned at the foot, Remove the danger button');

            // 3. Test stays on the page and sends the test; Edit opens the form in the page, Cancel returns to it
            await ev(`document.querySelector('.servers-page [data-action=test]').click(); true`);
            await waitFor(`window.__calls.includes('test lan')`, 'the test request');
            await waitFor(`!!document.getElementById('servers-page-name') && !document.querySelector('[data-action=test][disabled]')`, 'back on the page after the test');
            await ev(`document.querySelector('.servers-page [data-action=edit]').click(); true`);
            await waitFor(`!!document.getElementById('servers-form') && !!document.getElementById('servers-back')`, 'the edit form on the page');
            await ev(`[...document.querySelectorAll('#servers-form .sv-bar .btn')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
            await waitFor(`!!document.getElementById('servers-page-name') && !document.getElementById('servers-form')`, 'the page again');
            ok(at + 'Test stays on the page; Edit is the form in the page, Cancel returns to the page');

            // 4. Remove asks in the bar; Cancel keeps it; Confirm removes it and goes back to the table
            await ev(`document.querySelector('.servers-page [data-action=delete]').click(); true`);
            await waitFor(`!!document.querySelector('.servers-page [data-action=delete-confirm]')`, 'the confirmation');
            const c = await ev(`[...document.querySelectorAll('.servers-page .item-bar button')].map(b => [b.textContent.trim(), b.classList.contains('btn-danger')])`);
            assert.deepEqual(c, [['Cancel', false], ['Confirm remove', true]], at + 'the confirmation is in the bar, the danger button last');
            await ev(`document.querySelector('.servers-page [data-action=delete-cancel]').click(); true`);
            await waitFor(`!!document.querySelector('.servers-page [data-action=delete]')`, 'Cancel');
            assert.equal(await ev(`window.__calls.some(c => c.startsWith('delete'))`), false, at + 'Cancel removes nothing');
            await ev(`document.querySelector('.servers-page [data-action=delete]').click(); true`);
            await waitFor(`!!document.querySelector('.servers-page [data-action=delete-confirm]')`, 'the confirmation again');
            await ev(`document.querySelector('.servers-page [data-action=delete-confirm]').click(); true`);
            await waitFor(`window.__calls.includes('delete lan') && !!document.querySelector('table.dt-table') && !document.querySelector('#server-row-lan')`, 'the table without the server');
            ok(at + 'Remove asks in the bar; Confirm removes the server and returns to the table');

            // 5. the way back: the text link returns to the table with the focus on that server
            await ev(`document.querySelector('#server-row-epoch [data-action=open]').click(); true`);
            await waitFor(`!!document.getElementById('servers-back')`, 'the page');
            await ev(`document.getElementById('servers-back').click(); true`);
            await waitFor(`!!document.querySelector('table.dt-table')`, 'the table');
            assert.equal(await ev(`document.activeElement.closest('tr') && document.activeElement.closest('tr').id`), 'server-row-epoch', at + 'the focus is on the server it came from');
            ok(at + 'the way back returns to the table with the focus on that server');
            await ev(`window.__list = ${JSON.stringify(SERVERS)}; true`);
        }
        console.log('PASS servers page');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
