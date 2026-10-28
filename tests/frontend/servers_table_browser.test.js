// Servers page as a table (#5927) - setup from servers_tab_browser
// Servers tab (#3070): the Cloud Hub's machines (and a self-hosted hub's remotes) are a top-level tab, not a
// dialog. Pins: when the tab shows, the nav button's aria-current, the region and focus, each row's one lower-only
// 'Hub access' control (Follow this computer / Limit to Interact / Limit to View: PATCH {access_mode}, no Raise, no Launch dialog), Revoke
// contrast, deep links (#servers, #servers/<id>, the agent list's server chip), no overflow at 375 px with the
// actions stacked, and the enroll page's Servers note.
//
// Drives Chrome over CDP (chrome-remote-interface) through agent_view_harness.js; run_cdp_suites.mjs
// finds CDP suites by that name.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { themeJs } = require('./helpers/theme');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;
const { framesJs } = require('./helpers/wait');

const SERVERS = [
    { id: 'm1', label: 'Box One', online: true, access_mode: 'view', local_mode: 'launch', last_seen: '2026-10-13T00:00:00Z' },
    { id: 'm2', label: 'box two', online: true, access_mode: 'follow', local_mode: 'view', last_seen: '2026-10-13T00:00:00Z' },
    { id: 'm3', label: 'Box Three', online: false, access_mode: 'follow', local_mode: 'launch', last_seen: '2026-10-12T00:00:00Z' },
    { id: 'm4', label: 'Box Four', online: true, access_mode: 'interact', effective_mode: 'view', limited_by: 'machine', last_seen: '2026-10-13T00:00:00Z' },
];
const SESSIONS = [{ session_id: 'a1', name: 'waiter', agent_type: 'claude', server: 'm1', waiting_for_input: true }, { session_id: 'a2', name: 'busy', agent_type: 'claude', server: 'm1', waiting_for_input: false }]; // one agent of Box One waits for its person (the Needs you column)
const LIVE = [
    { id: 'm1', label: 'Box One', status: 'online', coral_version: '1.4.10', agents: 7, update: 'required', latest_coral: '1.5.0' },
    { id: 'm2', label: 'box two', status: 'online', version: '1.4.9', agents: 1, update: 'available', latest_coral: '1.5.0' },
    { id: 'm3', label: 'Box Three', status: 'offline', coral_version: '1.5.0', agents: 0, update: 'current' },
    { id: 'm4', label: 'Box Four', status: 'online', agents: 12, update: 'unknown' },
];
const DOWNLOAD = 'https://coralhub.dev/coral.html#download';

const CLOUD_PRELOAD = `(() => {
    window.__qaServers = ${JSON.stringify(SERVERS)};
    window.__patches = []; window.__serverGets = 0;
    const inner = window.fetch;
    window.fetch = (url, opts = {}) => {
        const p = new URL(String(url), location.origin).pathname;
        const m = (opts.method || 'GET').toUpperCase();
        if (p === '/api/servers' && m === 'GET') {
            window.__serverGets++;
            return Promise.resolve(new Response(JSON.stringify({ servers: window.__qaServers }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        const pm = p.match(/^\\/api\\/servers\\/([^/]+)$/);
        if (pm && m === 'PATCH') {
            const body = JSON.parse(opts.body || '{}');
            window.__patches.push({ id: decodeURIComponent(pm[1]), body });
            const row = window.__qaServers.find(s => s.id === decodeURIComponent(pm[1]));
            if (row && body.access_mode) row.access_mode = body.access_mode;
            return Promise.resolve(new Response(JSON.stringify(row || {}), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (pm && m === 'DELETE') { (window.__deletes = window.__deletes || []).push(decodeURIComponent(pm[1])); return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); }
        return inner(url, opts);
    };
})();`;

// WCAG contrast ratio of two 'rgb(...)' colours.
const contrast = (a, b) => {
    const lum = c => {
        const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;

    const cloudMode = async on => {
        await Fetch.disable();
        if (!on) return;
        await Fetch.enable({ patterns: [
            { urlPattern: `${BASE}/*`, resourceType: 'Document', requestStage: 'Response' }, // every dashboard page (#3532)
            { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' },
        ] });
    };
    safePaused(client, async e => {
        if (e.request.url.endsWith('/auth/session')) {
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
                body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
        }
        if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
        const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
        const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
        const headers = (e.responseHeaders || []).filter(h => !/^content-(length|encoding)$/i.test(h.name));
        return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
    });
    const open = async (where = '') => { // a path ("servers/m2") or an old hash link ("#servers")
        // A fresh load every time: since #3529 the dashboard URL has no query, so going from
        // /#a to /#b is a same-document hash change that fires no load event. Each wait is
        // registered before its navigation, or about:blank's quick load could be missed.
        const blank = Page.loadEventFired();
        await Page.navigate({ url: 'about:blank' });
        await blank;
        const loaded = Page.loadEventFired();
        await Page.navigate({ url: BASE + '/' + where });
        await loaded;
        await install();
        await ev(`(() => { T.state.servers = ${JSON.stringify(LIVE)}; T.state.liveSessions = ${JSON.stringify(SESSIONS)}; return true; })()`);
    };
    const tabState = () => ev(`(() => {
        const tab = document.getElementById('nav-tab-servers'), view = document.getElementById('servers-view');
        return {
            tabShown: !!tab && !tab.hidden && getComputedStyle(tab).display !== 'none',
            role: tab && tab.getAttribute('role'), controls: tab && tab.getAttribute('aria-controls'), selected: tab && tab.getAttribute('aria-selected'), current: tab && tab.getAttribute('aria-current'),
            viewShown: !!view && getComputedStyle(view).display !== 'none', viewRole: view && view.getAttribute('role'),
            focus: document.activeElement && document.activeElement.id,
        };
    })()`);
    const rows = () => ev(`[...document.querySelectorAll('#servers-view .cs-row')].map(r => ({
        id: r.id, tabindex: r.getAttribute('tabindex'),
        access: (r.querySelector('.cs-access') || {}).textContent || '',
        target: r.classList.contains('server-row-target'),
    }))`);

    try {
        await Promise.all([Page.enable(), Network.enable()]);
        await Network.setBypassServiceWorker({ bypass: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: CLOUD_PRELOAD });
        await cloudMode(true);
        const { themeJs } = require('./helpers/theme');
        const { installAudit, auditRegion, setTheme } = require('./helpers/contrast');
        const shot = async name => { if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
        const table = () => ev(`(() => { const t = document.querySelector('#servers-view table.cs-table'); if (!t) return null;
            const rows = [...t.querySelectorAll('tbody > tr.cs-row')];
            return { role: t.getAttribute('role'), label: t.getAttribute('aria-label'),
                actionsHead: (t.querySelector('thead th.cs-col-actions') || {}).textContent || null, heads: [...t.querySelectorAll('thead th')].filter(th => th.querySelector('button')).map(th => ({ text: th.textContent.replace(/[▲▼↑↓↕]/g, '').trim(), sort: th.getAttribute('aria-sort'), scope: th.getAttribute('scope'), button: !!th.querySelector('button') })),
                names: rows.map(r => r.querySelector('.cs-name').textContent),
                rows: rows.map(r => ({ id: r.id, status: r.querySelector('.cs-col-status').textContent, version: r.querySelector('.cs-col-version').textContent, agents: r.querySelector('.cs-col-agents').textContent, needs: r.querySelector('.cs-col-needs').textContent.trim(), seen: r.querySelector('.cs-col-seen').textContent.trim(),
                    select: r.querySelector('.cs-col-access select').value, selectLabel: r.querySelector('.cs-col-access .sr-only').textContent.trim(),
                    open: !!r.querySelector('.cs-toggle.cs-open'), noChevron: !r.querySelector('.cs-chevron') && !r.querySelector('[aria-expanded]') })) }; })()`);
        const pageOpen = id => `!!document.querySelector('#servers-view section.cs-page#server-row-${id}')`;
        const openPage = async id => { await ev(`document.querySelector('#server-row-${id} .cs-toggle').focus(); document.querySelector('#server-row-${id} .cs-toggle').click(); true`); await waitFor(pageOpen(id), `${id}'s page`, 3000); assert.equal(await ev('location.pathname'), '/servers/' + id, `${id}'s page is in the address`); };
        const backToList = async id => { await ev(`document.getElementById('servers-back').click(); true`); await waitFor(`document.querySelectorAll('#servers-view tr.cs-row').length === ${SERVERS.length}`, 'the list is back', 3000); assert.equal(await ev('location.pathname'), '/servers', 'the list is at /servers'); if (id) assert.equal(await ev(`document.activeElement === document.querySelector('#server-row-${id} .cs-toggle')`), true, `Back puts the keyboard on ${id}'s row`); };
        const sortBy = key => ev(`document.querySelector('#servers-view .cs-sort[data-key="${key}"]').click(); true`);
        const open = async (where = '') => {
            const blank = Page.loadEventFired(); await Page.navigate({ url: 'about:blank' }); await blank;
            const loaded = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' + where }); await loaded;
            await install();
            await ev(`(() => { T.state.servers = ${JSON.stringify(LIVE)}; return true; })()`);
            if (!where) { await ev(`document.getElementById('nav-tab-servers').click(); true`); await waitFor(`!!document.querySelector('#servers-view table.cs-table')`, 'the Servers page', 8000); }
        };

        console.log('1. The Servers page is a table: columns, rows (each opens its machine\'s page), Add a machine at the top');
        await open();
        await waitFor(`document.querySelectorAll('#servers-view tr.cs-row').length === ${SERVERS.length}`, 'the rows', 6000);
        await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(SESSIONS)}; (await import((window.__coralStatic || '/static/') + 'cloud_server_view.js')).serverView.render(); return true; })()`); // the live list reaches the page after its first draw: draw again with it (Needs you reads it)
        let t = await table();
        assert.equal(t.role, 'table'); assert.equal(t.label, 'Your computers');
        assert.deepEqual(t.heads.map(h => h.text), ['Name', 'Status', 'Agents', 'Needs you', 'Last seen', 'Coral', 'Hub access']);
        assert.ok(t.heads.every(h => h.scope === 'col' && h.button), 'every sortable header is a button in a column header');
        assert.equal(t.actionsHead, null, 'no Actions column: Rename and Revoke are on the machine\'s page');
        assert.deepEqual(t.heads.map(h => h.sort), ['ascending', 'none', 'none', 'none', 'none', 'none', 'none'], 'sorted by name, ascending, to start with');
        assert.deepEqual(t.names, ['Box Four', 'Box One', 'Box Three', 'box two'].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), 'by name, case ignored');
        const m1 = t.rows.find(r => r.id === 'server-row-m1');
        assert.equal(m1.status, 'Online'); assert.equal(m1.version.replace(/\s+/g, ' ').trim(), '1.4.10 Update required'); assert.equal(m1.agents, '7');
        assert.equal(m1.needs, '1', 'Needs you: the agent that waits: ' + JSON.stringify(t.rows.map(r => [r.id, r.needs, r.seen]))); assert.ok(t.rows.filter(r => r.id !== 'server-row-m1').every(r => r.needs === ''), 'and nothing at zero');
        assert.ok(t.rows.filter(r => r.id !== 'server-row-m3').every(r => r.seen === 'now') && t.rows.find(r => r.id === 'server-row-m3').seen !== 'now' && t.rows.find(r => r.id === 'server-row-m3').seen !== '', 'Last seen: now while online, the contact time for an offline machine: ' + JSON.stringify(t.rows.map(r => r.seen)));
        assert.equal(m1.select, 'view'); assert.equal(m1.selectLabel, 'Hub access for Box One');
        assert.ok(t.rows.every(r => r.open && r.noChevron), 'every row is one button that opens its machine\'s page: no chevron, nothing expands in place');
        const order = await ev(`[...document.getElementById('cs-add-machine').parentElement.children].map(e => e.id || e.className.split(' ')[0])`);
        assert.ok(order.indexOf('cs-add-machine') >= 0 && order.indexOf('cs-add-machine') < order.findIndex(x => /dt-box/.test(x)), 'Add a machine comes before the table: ' + order);
        console.log('   ok');

        const lay = await ev(`[...document.querySelectorAll('#servers-view tr.cs-row')].map(r => { const t = r.querySelector('.cs-toggle').getBoundingClientRect(), d = r.querySelector('.machine-health-dot').getBoundingClientRect(), v = r.querySelector('.cs-col-version span').getBoundingClientRect(), b = r.querySelector('.server-update-badge'); return { sameLine: Math.abs((d.top + d.height / 2) - (t.top + t.height / 2)) < 8, badgeInline: !b || Math.abs((b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2) - (v.top + v.height / 2)) < 8 }; })`);
        const fit = await ev(`(() => { const t = document.querySelector('#servers-view .cs-table').getBoundingClientRect(), p = document.getElementById('cs-add-machine').getBoundingClientRect(); return { tr: Math.round(t.right), pr: Math.round(p.right) }; })()`);
        assert.ok(fit.tr <= fit.pr + 1, 'the table is no wider than the Add a machine panel above it: ' + JSON.stringify(fit));
        assert.ok(lay.every(x => x.sameLine && x.badgeInline), 'on a desktop the health dot is beside the name and the update badge beside the version: ' + JSON.stringify(lay));
        console.log('2. Sorting: each header sorts, a second press reverses, aria-sort follows, versions compare as numbers');
        await sortBy('version');
        t = await table();
        assert.deepEqual(t.heads.map(h => h.sort), ['none', 'none', 'none', 'none', 'none', 'ascending', 'none']);
        assert.deepEqual(t.names, ['Box Four', 'box two', 'Box One', 'Box Three'], '(none), 1.4.9, 1.4.10, 1.5.0: 1.4.10 is after 1.4.9');
        await sortBy('version');
        assert.deepEqual((await table()).names, ['Box Three', 'Box One', 'box two', 'Box Four']);
        await sortBy('agents');
        t = await table(); assert.equal(t.heads[2].sort, 'descending', 'agents start with the most');
        assert.deepEqual(t.names, ['Box Four', 'Box One', 'box two', 'Box Three']);
        await sortBy('seen');
        t = await table(); assert.equal(t.heads[4].sort, 'descending', 'Last seen starts with the most recent');
        assert.deepEqual(t.names, ['Box Four', 'Box One', 'box two', 'Box Three'], 'online machines first (now), then the offline one by when it was last heard from');
        await sortBy('seen');
        t = await table(); assert.equal(t.heads[4].sort, 'ascending'); assert.equal(t.names[0], 'Box Three', 'the second press reverses: the longest-silent first');
        await sortBy('status');
        t = await table(); assert.equal(t.heads[1].sort, 'ascending');
        assert.equal(t.rows[0].status, 'Offline', 'ascending: offline first');
        await sortBy('access');
        t = await table(); assert.equal(t.heads[6].sort, 'descending');
        assert.deepEqual(t.names[0], 'Box Three', 'the most access first (following a computer that allows Launch)');
        await sortBy('name');
        assert.deepEqual((await table()).heads.map(h => h.sort), ['ascending', 'none', 'none', 'none', 'none', 'none', 'none']);
        // The keyboard: a header is a button; Enter and Space press it, and focus stays on it.
        await ev(`document.querySelector('#servers-view .cs-sort[data-key="agents"]').focus(); true`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await waitFor(`document.querySelector('#servers-view .cs-th[aria-sort="descending"]') && document.activeElement && document.activeElement.classList.contains('cs-sort') && document.activeElement.dataset.key === 'agents'`, 'Enter sorts by agents and focus stays on the header', 3000);
        await sortBy('name');
        console.log('   ok');

        console.log('3. A row opens the machine\'s page: its details, Rename and Revoke are there, Back returns to the row');
        assert.equal(await ev(`[...document.querySelectorAll('#servers-view tr.cs-row button')].filter(b => !b.classList.contains('cs-toggle')).length`), 0, 'no Rename, More or Revoke in any row: the row\'s one button opens the page');
        await openPage('m1');
        assert.equal(await ev(`document.querySelectorAll('#servers-view tr.cs-row').length`), 0, 'the list is not on screen while a machine\'s page is open');
        assert.equal(await ev(`document.activeElement.id`), 'server-row-m1', 'the keyboard is on the page');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#server-row-m1 .cs-actions button')].map(b => b.textContent + '|' + b.getAttribute('aria-label'))`), ['Rename|Rename Box One', 'More|More for Box One', 'Revoke|Revoke Box One'], 'Rename, More and Revoke (in More), named with the machine, in the page\'s foot bar');
        const d = await ev(`(() => { const x = document.querySelector('#server-row-m1 .cs-detail-cell'); return { text: x.textContent.replace(/\\s+/g, ' '), buttons: [...x.querySelectorAll('button:not(.cs-access-info)')].map(b => b.textContent.trim()), update: (x.querySelector('.cs-update a') || {}).href || null, focus: document.activeElement && document.activeElement.id === 'server-row-m1' }; })()`);
        assert.deepEqual(d.buttons, [], 'the details hold no machine-action buttons');
        const infoState = () => ev(`(() => { const b = document.querySelector('#server-row-m1 .cs-access-info'), p = document.getElementById(b.getAttribute('aria-controls')); return { open:b.getAttribute('aria-expanded'), hidden:p.hidden, words:p.textContent, focus:document.activeElement===b }; })()`);
        assert.equal((await infoState()).open, 'false');
        assert.equal((await infoState()).hidden, true, 'the complete access matrix starts folded');
        await ev(`document.querySelector('#server-row-m1 .cs-access-info').focus(); document.querySelector('#server-row-m1 .cs-access-info').click(); true`);
        const info = await infoState();
        assert.equal(info.open, 'true'); assert.equal(info.hidden, false); assert.equal(info.focus, true, 'focus survives the redraw');
        assert.match(info.words, /View:.*Interact:.*Launch:/, 'every access level remains available on demand');
        assert.match(info.words, /What Coral Hub may do on a machine is what you allowed when you connected it; you can limit it further here\./, 'the enrollment access limit remains reachable');
        assert.match(info.words, /turn on auto-accept/, 'the complete capability text is preserved');
        await ev(`document.querySelector('#server-row-m1 .cs-access-info').click(); true`);
        assert.equal(d.update, DOWNLOAD, 'the update notice points to the download page, not GitHub');
        assert.doesNotMatch(d.text, /Follow this computer|Limit to|Hub: |Machine: /, 'none of the old wording');
        assert.ok(d.focus, 'focus is on the page');
        // Status and Health agree: an online machine with no reading yet is waiting for one, never "not connected".
        const hc = [];
        for (const id of ['m1', 'm2', 'm4']) { if (id !== 'm1') await openPage(id); hc.push({ status: await ev(`document.querySelector('#server-row-${id} .cs-facts dd').textContent`), note: await ev(`((document.querySelector('#server-row-${id} .cs-detail-cell .machine-health-note')) || {}).textContent || null`) }); if (id !== 'm4') await backToList(id); }
        assert.ok(hc.filter(x => x.status === 'Online').every(x => x.note === 'No health reading yet.'), 'online machines wait for a reading: ' + JSON.stringify(hc));
        assert.ok(!hc.some(x => x.status === 'Online' && /not connected/.test(x.note || '')), 'no online machine says not connected');
        await backToList('m4');
        const rowName = id => ev(`document.querySelector('#server-row-${id} .cs-toggle').getAttribute('aria-label')`);
        assert.equal(await rowName('m3'), 'Open Box Three, offline', 'the row button says the state once');
        assert.match(await rowName('m1'), /^Open Box One, online(, warning: .+)?$/, 'online, and a warning only when there is one'); // the #9683 rule
        await openPage('m1'); await ev('history.back(); true'); await waitFor(`document.querySelectorAll('#servers-view tr.cs-row').length === ${SERVERS.length}`, 'browser Back closes the page', 3000); await ev('history.forward(); true'); await waitFor(pageOpen('m1'), 'browser Forward reopens it', 3000); // the page is an address (#9722)
        const once = await ev(`(() => { const pg = document.querySelector('#server-row-m1'), dt = [...pg.querySelectorAll('.cs-facts dt')].find(x => x.textContent === 'Hub access'), sel = pg.querySelector('.cs-facts select'), info = pg.querySelector('.cs-access-info'), ics = getComputedStyle(info), rg = document.createRange(), sr = sel.getBoundingClientRect(); rg.selectNodeContents(dt); const dr = rg.getBoundingClientRect(); /* the label's own text line: the dt box stretches to the row */ return { healthDot: !!pg.querySelector('.cs-page-name .machine-health-dot'), offsetMid: Math.round(Math.abs((dr.top + dr.height / 2) - (sr.top + sr.height / 2))), infoBorder: ics.borderTopColor, infoLeft: Math.round(info.getBoundingClientRect().left - pg.querySelector('.cs-detail-cell').getBoundingClientRect().left), infoBg: ics.backgroundColor, infoColor: ics.color, primary: getComputedStyle(document.body).getPropertyValue('--text-primary').trim(), cls: info.className }; })()`);
        assert.equal(once.healthDot, false, 'the page says the state once: the dot and the Status row, no hollow health circle after the name (#9798) ' + JSON.stringify(once));
        assert.ok(once.offsetMid <= 4, 'the Hub access label sits on its select\'s text line, not above it (#9798): ' + JSON.stringify(once));
        assert.ok(once.infoLeft <= 1, 'Access details starts at the text edge above it, not inset (#9798): ' + JSON.stringify(once));
        assert.ok(/btn-quiet/.test(once.cls) && /rgba\(0, 0, 0, 0\)|transparent/.test(once.infoBorder) && /rgba\(0, 0, 0, 0\)|transparent/.test(once.infoBg), 'Access details is the quiet text button (a transparent border, no fill), not a grey box that reads as disabled (#9798): ' + JSON.stringify(once));
        await shot('table-desktop-open'); // a machine's page (Box One)
        await backToList('m1');
        await openPage('m3');
        // Revoke asks in the row (Confirm revoke / Cancel) and opens the details for the warning; Cancel puts the row back.
        // Revoke is one step further than Rename: it sits in a More menu, closed until asked (#6370 follow-up, the row keeps Rename and the one thing most visits do).
        const seen = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility({ checkVisibilityCSS: true }); })()`;
        assert.equal(await ev(seen('#server-row-m3 .cs-revoke')), false, 'Revoke is not on the row until More is opened');
        assert.equal(await ev(`document.querySelector('#server-row-m3 .cs-more-btn').getAttribute('aria-label')`), 'More for Box Three');
        await ev(`document.querySelector('#server-row-m3 .cs-more-btn').click(); true`);
        assert.equal(await ev(seen('#server-row-m3 .cs-revoke')), true, 'More shows Revoke');
        assert.deepEqual(await ev(`(() => { const b = document.querySelector('#server-row-m3 .cs-more-btn'); return [b.getAttribute('aria-expanded'), b.hasAttribute('aria-haspopup'), !!document.getElementById(b.getAttribute('aria-controls'))]; })()`), ['true', false, true], 'More is a disclosure (expanded, controls its group), not a role=menu');
        await shot('table-desktop-more-open');
        await ev(`document.querySelector('#server-row-m3 .cs-more').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        assert.equal(await ev(seen('#server-row-m3 .cs-revoke')), false, 'Escape closes More');
        // a click anywhere else closes an open More (the menu would otherwise stay over the list); a click on its own button toggles it
        await ev(`document.querySelector('#server-row-m3 .cs-more-btn').click(); true`);
        assert.equal(await ev(seen('#server-row-m3 .cs-revoke')), true, 'More opens again');
        await ev(`document.body.click(); true`);
        await waitFor(`!document.querySelector('#server-row-m3 .cs-revoke') || document.querySelector('#server-row-m3 .cs-revoke').getClientRects().length === 0`, 'a click elsewhere closed More', 3000);
        await ev(`document.querySelector('#server-row-m3 .cs-more-btn').click(); true`);
        await ev(`document.querySelector('#server-row-m3 .cs-more-btn').click(); true`);
        assert.equal(await ev(seen('#server-row-m3 .cs-revoke')), false, 'the More button toggles: a second click closes it');
        assert.equal(await ev(`document.activeElement === document.querySelector('#server-row-m3 .cs-more-btn')`), true, 'and keeps the keyboard on More');
        await ev(`document.querySelector('#server-row-m3 .cs-more-btn').click(); document.querySelector('#server-row-m3 .cs-revoke').click(); true`);
        await waitFor(`!!document.querySelector('#server-row-m3 .cs-actions .btn-danger')`, 'the revoke confirmation', 3000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#server-row-m3 .cs-actions button')].map(b => b.textContent)`), ['Confirm revoke', 'Cancel']);
        assert.match(await ev(`document.querySelector('#server-row-m3 .cs-detail-cell').textContent`), /Revoke Box Three\? It disconnects this computer from Coral Hub\./);
        assert.ok(await ev(`!!document.querySelector('#server-row-m3 .cs-detail-cell .cs-note')`), 'the page shows the warning');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#server-row-m3 .cs-facts dt')].map(x => x.textContent).filter(t => /Last/.test(t))`), ['Last seen'], 'an offline machine\'s page calls it Last seen too, the list column\'s word, once (#9798)');
        await shot('page-desktop-revoke-confirm'); // an offline machine's page asking to revoke: the warning, Confirm revoke and Cancel (#9786: so it can be looked at; the others are page-<desktop|phone>-<dark|light> and table-*)
        // Revoke is never one click and never loses the keyboard: the ask puts focus on Cancel (the safe answer), the question is the buttons' description, Cancel and Escape leave the machine
        // connected (no DELETE) and put focus back on that row's Revoke.
        assert.equal(await ev(`document.activeElement.classList.contains('cs-revoke-cancel')`), true, 'the ask moves focus to Cancel');
        assert.equal(await ev(`(() => { const d = document.getElementById(document.activeElement.getAttribute('aria-describedby')); return !!d && /Revoke Box Three\\? It disconnects this computer from Coral Hub\\./.test(d.textContent); })()`), true, 'the buttons are described by the question');
        await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
        await waitFor(`!!document.querySelector('#server-row-m3 .cs-revoke')`, 'Escape put the row actions back', 3000);
        assert.equal(await ev(`document.activeElement === document.querySelector('#server-row-m3 .cs-more-btn')`), true, 'Escape returns focus to More');
        assert.equal(await ev(`(window.__deletes || []).length`), 0, 'nothing was revoked');
        await ev(`document.querySelector('#server-row-m3 .cs-more-btn').click(); document.querySelector('#server-row-m3 .cs-revoke').click(); true`);
        await waitFor(`!!document.querySelector('#server-row-m3 .cs-actions .btn-danger')`, 'the revoke confirmation again', 3000);
        await ev(`[...document.querySelectorAll('#server-row-m3 .cs-actions button')].find(b => b.textContent === 'Cancel').click(); true`);
        await waitFor(`!!document.querySelector('#server-row-m3 .cs-revoke')`, 'the row actions back', 3000);
        assert.equal(await ev(`document.activeElement === document.querySelector('#server-row-m3 .cs-more-btn')`), true, 'Cancel returns focus to More');
        assert.equal(await ev(`(window.__deletes || []).length`), 0, 'still nothing revoked');
        // Rename on the page: the heading becomes a form.
        await backToList('m3'); await openPage('m4');
        await ev(`document.querySelector('#server-row-m4 .cs-rename-btn').click(); true`);
        await waitFor(`!!document.querySelector('#server-row-m4 .cs-rename input[name=label]')`, 'the rename form', 3000);
        await ev(`[...document.querySelectorAll('#server-row-m4 .cs-rename button')].find(b => b.textContent === 'Cancel').click(); true`);
        await waitFor(`!document.querySelector('#server-row-m4 .cs-rename')`, 'rename cancelled', 3000);
        await backToList('m4');
        console.log('   ok');

        console.log('4. Add a machine: closed for an existing account, with the original steps on demand');
        assert.equal(await ev(`document.querySelector('#cs-enroll-toggle').getAttribute('aria-expanded')`), 'false');
        await ev(`document.querySelector('#cs-enroll-toggle').click(); true`);
        assert.equal(await ev(`document.querySelector('#cs-enroll-body').hidden`), false);
        await waitFor(`document.querySelector('.cs-shot-dark').naturalWidth > 0`, 'the disclosed local picture');
        const a = await ev(`(() => { const e = document.getElementById('cs-add-machine'); const links = [...e.querySelectorAll('a')].map(x => x.href);
            const imgs = [...e.querySelectorAll('img')].map(i => ({ src: new URL(i.src).origin === location.origin, name: i.src.split('/').pop(), alt: i.alt, shown: getComputedStyle(i).display !== 'none', w: i.getBoundingClientRect().width, nat: i.naturalWidth }));
            return { links, imgs, text: e.textContent.replace(/\\s+/g, ' '), steps: e.querySelectorAll('ol li').length, code: !!e.querySelector('#cs-enroll-code') }; })()`);
        assert.deepEqual(a.links, [DOWNLOAD], 'one link: the download page');
        assert.doesNotMatch(a.text, /brew|github/i, 'no brew command and no GitHub link');
        assert.equal(a.steps, 4); assert.ok(a.code, 'the code form is still there');
        assert.ok(a.imgs.every(i => i.src && i.nat > 0), 'the pictures are this server\'s own and load: ' + JSON.stringify(a.imgs));
        assert.equal(a.imgs.filter(i => i.shown).length, 1, 'one picture per theme is shown');
        assert.match(a.imgs.find(i => i.shown).alt, /What may Coral Hub do on this computer\?/);
        assert.doesNotMatch(await ev(`document.documentElement.outerHTML`), /github\.com\/subgentic\/coral\/releases/, 'the page has no GitHub releases link');
        console.log('   ok');

        console.log('5. Deep link: /servers/<id> opens that machine\'s page');
        await open('servers/m2');
        await waitFor(pageOpen('m2'), 'm2\'s page from the link', 6000);
        console.log('   ok');

        console.log('6. Both themes at 4.5:1 and the shots (desktop, then a phone)');
        for (const [w, h, mobile, tag, touch] of [[1280, 900, false, 'desktop', false], [390, 844, true, 'phone', true], [820, 1100, false, 'tablet', true]]) { // a touch tablet: a coarse pointer above a phone's width (QA Engineer's note on #9814)
            await client.Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await client.Emulation.setTouchEmulationEnabled({ enabled: touch }); // a phone is a touch screen: its targets are 44 px
            await open();
            await waitFor(`document.querySelectorAll('#servers-view tr.cs-row').length === ${SERVERS.length}`, 'rows', 6000);
            await installAudit(ev);
            for (const theme of ['dark', 'light']) {
                await setTheme(ev, theme);
                const au = await auditRegion(ev, ['#cs-add-machine', '#servers-view .cs-table']);
                assert.ok(au.checked > 0 && !au.fails.filter(f => !/Revoke/.test(f.text || '')).length, `${tag} ${theme}: 4.5:1 ${JSON.stringify(au.fails).slice(0, 400)}`);
                const tg = await ev(`(() => { const hs = [...document.querySelectorAll('#servers-view .cs-sort, #servers-view .cs-toggle, #servers-view .dt-sortbar-select')].filter(b => b.getClientRects().length).map(b => Math.round(b.getBoundingClientRect().height)); return Math.min(...hs); })()`);
                assert.ok(tg >= (touch ? 44 : 24), `${tag} ${theme}: the sort headers and row toggles are big enough targets (${tg} px: 24 with a mouse, 44 under touch, a phone or a tablet)`);
                const over = await ev(`document.documentElement.scrollWidth - innerWidth`);
                assert.ok(over <= 0, `${tag}: no sideways scroll (${over})`);
                await ev(`document.querySelector('#servers-view .cs-table').scrollIntoView(); true`);
                await shot(`table-${tag}-${theme}`);
            }
            await openPage('m1'); // the machine's page too: 4.5:1 in both themes, and no sideways scroll
            for (const theme of ['dark', 'light']) {
                await setTheme(ev, theme);
                const au = await auditRegion(ev, ['#servers-view section.cs-page']);
                assert.ok(au.checked > 0 && !au.fails.filter(f => !/Revoke/.test(f.text || '')).length, `${tag} ${theme} (the machine's page): 4.5:1 ${JSON.stringify(au.fails).slice(0, 400)}`);
                const over = await ev(`document.documentElement.scrollWidth - innerWidth`);
                assert.ok(over <= 0, `${tag}: the page has no sideways scroll (${over})`);
                await shot(`page-${tag}-${theme}`);
            }
            await setTheme(ev, 'dark');
        }
        await client.Emulation.clearDeviceMetricsOverride(); await client.Emulation.setTouchEmulationEnabled({ enabled: false });
        console.log('   ok');
        console.log('\nAll Servers table checks passed');
    } finally {
        await client.close();
    }
})().catch(err => {
    console.error(err);
    process.exit(1);
});
