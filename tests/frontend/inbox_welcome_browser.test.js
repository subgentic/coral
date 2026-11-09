// The Inbox's welcome items for a new install (#11443): with the server's inbox_welcome = on, Needs you holds six items, each a real action that marks itself done when its step is seen (an agent exists, a team
// exists, a computer or the Hub is connected), read or dismissed; they are not in the Inbox badge; each is dismissed one at a time like any other item (no Hide all, #14742); an empty Needs you says "Nothing needs you" with a way to Agents; an install
// without the setting never sees them. At 1280 and 390 px, through agent_view_harness.js against the isolated dev server (the settings the page keeps are put in its state; the PUTs are answered here).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const TITLES = ['Welcome to Coral', 'Start your first agent', 'Make a team so agents can work together', 'Connect a second computer or the Hub', 'How agents ask you for things', 'Read the Coral guide'];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            // the page's own state: a new install (the setting on, nothing done), no agents, no computers; the team list and the settings save are answered here
            await ev(`window.__puts = []; window.__teams = []; window.__realFetch = window.__realFetch || window.fetch; window.fetch = (u, o) => { const s = String(u), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (s.includes('/api/board/projects')) return json(window.__teams);
                if (s.includes('/api/settings') && o && o.method === 'PUT') { window.__puts.push(JSON.parse(o.body)); return json({ ok: true }); }
                return window.__realFetch(u, o); };
                T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; T.state.liveSessions = []; T.state.servers = []; true`);
            // a button of the list, pressed once it is there: the list is redrawn when the proposals and the settings are read, so a button found a moment ago may be gone
            const press = async (label, sel = '#group-table-view button', nth = 0) => { await waitFor(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.textContent === ${JSON.stringify(label)}).length > ${nth}`, `${tag}: the ${label} button`, 8000); await ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.textContent === ${JSON.stringify(label)})[${nth}].click(); true`); };
            const open = () => ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            /* the kind icon is the name's first child since #13144: the title is its first node that is not the icon */ const titles = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].map(e => { const t = [...e.childNodes].find(n => !(n.nodeType === 1 && n.classList.contains('inbox-kind-icon'))); return t ? t.textContent : ''; })`);
            await open();
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 6`, `${tag}: six welcome items`, 8000);
            check(JSON.stringify(await titles()) === JSON.stringify(TITLES), `${tag}: the six items in order: ` + JSON.stringify(await titles()));
            const acts = await ev(`[...document.querySelectorAll('#group-table-view .inbox-review-actions')].map(b => [...b.querySelectorAll('button:not(.menu-item):not(.inbox-row-more-toggle)')].map(x => x.textContent))`);
            const want = mobile ? [['Got it'], ['New agent'], ['New team'], ['Connect'], ['Read it'], ['Open guide']] : [['Got it'], ['New agent', 'Dismiss'], ['New team', 'Dismiss'], ['Connect', 'Dismiss'], ['Read it', 'Dismiss'], ['Open guide', 'Dismiss']]; // a phone row has no Dismiss button: it is in the three-dot menu, or a swipe (#11642)
            check(JSON.stringify(acts) === JSON.stringify(want), `${tag}: each item's action, and Dismiss on all but the welcome (in the menu on a phone): ` + JSON.stringify(acts));
            check(await ev(`/optional/.test([...document.querySelectorAll('#group-table-view .inbox-welcome-name')][3].textContent)`), `${tag}: Connect is marked optional`);
            check(await ev(`![...document.querySelectorAll('#group-table-view button, #group-table-view .menu-item')].some(b => /hide all/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') || ''))) && !document.querySelector('.inbox-welcome-hide')`), `${tag}: no Hide all welcome items control (#14742): each is dismissed on its own`);
            check(await ev(`document.getElementById('nav-tab-hub-inbox-badge').hidden || document.getElementById('nav-tab-hub-inbox-badge').textContent === ''`), `${tag}: the items are not counted in the Inbox badge`);
            if (mobile) check(await ev(`[...document.querySelectorAll('#group-table-view .inbox-review-actions button:not(.menu-item)')].every(b => b.getBoundingClientRect().height >= 44)`), `${tag}: every action is a 44 px target`);

            // the actions do what they say
            await press('New agent');
            await waitFor(`(() => { const m = document.getElementById('launch-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`, `${tag}: New agent opens the launch dialog`, 5000);
            await ev(`window.hideLaunchModal(); true`);
            // an agent appears: its item completes itself and is remembered
            await ev(`T.state.liveSessions = [{ session_id: 'w1', name: 'coral-w1', display_name: 'First', agent_type: 'claude', model: 'claude-opus-5-5', server: 'local', working: false }]; import(${S} + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 5`, `${tag}: Start your first agent completes itself`, 6000);
            check(await ev(`window.__puts.some(p => /agent/.test(p.inbox_welcome_done || ''))`), `${tag}: the completed step is remembered in the settings: ` + JSON.stringify(await ev(`window.__puts`)));
            // a team appears (the list is read while the step is open)
            await ev(`window.__teams = [{ name: 'alpha' }]; true`);
            await waitFor(`(import(${S} + 'inbox_tab.js').then(m => m.updateInboxTab()), !/Make a team/.test(document.getElementById('group-table-view').textContent))`, `${tag}: Make a team completes itself`, 15000);
            // Read it, then Got it
            await press('Read it');
            await waitFor(`(() => { const t = document.getElementById('confirm-modal-message'), m = document.getElementById('confirm-modal'); return !!t && !!m && /permission to allow/.test(t.textContent) && getComputedStyle(m).display !== 'none'; })()`, `${tag}: Read it shows how agents ask`, 5000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`!/How agents ask you/.test(document.getElementById('group-table-view').textContent)`, `${tag}: reading it clears the item`, 6000);
            // Dismiss the optional one; the welcome is left, then hidden for good
            const before = await ev(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length`);
            await press('Dismiss');
            await waitFor(`!/Connect a second/.test(document.getElementById('group-table-view').textContent)`, `${tag}: Dismiss puts an item away`, 6000);
            check(await ev(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length`) === before - 1, `${tag}: dismissing one welcome item took away only that row (${before} before)`);
            await waitFor(`/Welcome to Coral/.test(document.getElementById('group-table-view').textContent)`, `${tag}: the welcome is still there`, 6000);
            // the guide row opens getting-started.md in the same viewer as any review file, and is done once it is on screen (#14744); it was not fetched before this
            check(await ev(`!performance.getEntriesByType('resource').some(e => /guide\\/getting-started/.test(e.name))`), `${tag}: the guide is not fetched until its row is opened`);
            await press('Open guide');
            await waitFor(`(() => { const d = document.getElementById('artifact-viewer'); return !!d && !d.hidden && /Getting started with Coral/.test(d.querySelector('.artifact-viewer-title').textContent) && !!d.querySelector('.artifact-viewer-body h1, .artifact-viewer-body .md-h1, .artifact-viewer-body h2'); })()`, `${tag}: the guide opens in the viewer, drawn as a document`, 10000);
            check(await ev(`document.querySelectorAll('#artifact-viewer .artifact-viewer-body img').length > 0 && [...document.querySelectorAll('#artifact-viewer .artifact-viewer-body img')].every(i => i.naturalWidth > 0 || !i.complete)`), `${tag}: the guide's pictures are drawn`);
            await shot(`welcome-guide-${w}`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await waitFor(`!/Read the Coral guide/.test(document.getElementById('group-table-view').textContent)`, `${tag}: opening the guide clears its row`, 6000);
            await press('Got it'); // the last one: the welcome's own button
            await waitFor(`/Nothing needs you(?!r)/.test(document.getElementById('group-table-view').textContent)`, `${tag}: the empty Needs you says Nothing needs you`, 6000);
            check(await ev(`window.__puts.some(p => String(p.inbox_welcome_done || '').split(',').length === 6)`), `${tag}: with every item done or dismissed, all five are remembered in the settings`);
            await press('Go to Agents');
            await waitFor(`(() => { const t = document.querySelector('.top-nav-tab.active'); if (t && t.dataset.arg === 'agents') return true; const m = document.getElementById('mobile-agent-list'); return !!m && getComputedStyle(m).display !== 'none'; })()`, `${tag}: Go to Agents`, 5000);

            // an install that has run before: no setting, no items
            await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: undefined, inbox_welcome_done: '' }; T.state.liveSessions = []; true`);
            await open();
            await waitFor(`/Nothing needs you(?!r)/.test(document.getElementById('group-table-view').textContent)`, `${tag}: an existing install sees no welcome items`, 6000);
            // an install that chose Hide all before it was removed (inbox_welcome: 'off') keeps them hidden: nothing brings them back
            await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: 'off', inbox_welcome_done: '' }; true`);
            await open();
            await waitFor(`/Nothing needs you(?!r)/.test(document.getElementById('group-table-view').textContent)`, `${tag}: an install that hid them all earlier still sees none`, 6000);
            await ev(`window.fetch = window.__realFetch; true`);
        }
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the new-user Inbox: six items that complete themselves');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
