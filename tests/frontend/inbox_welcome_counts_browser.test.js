// probe
// exists, a computer or the Hub is connected), read or dismissed; they are not in the Inbox badge; each is dismissed one at a time (no Hide all, #14742); an empty Needs you says "You are all caught up" with a way to Agents; an install
// without the setting never sees them. At 1280 and 390 px, through agent_view_harness.js against the isolated dev server (the settings the page keeps are put in its state; the PUTs are answered here).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { quietLaunchNotice, restoreLaunchNotice } = require('./helpers/launch_notice');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const settingsGuard = await require('./helpers/settings_guard').guardSettings();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await quietLaunchNotice(Page, ev, process.env.CORAL_TEST_URL + '/'); /* the unseen first-run notice sits in the phone Inbox pane now (#16460) and shifts what these measure: acked on the test server */ await install();
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
            const titles = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].map(e => e.firstChild ? e.firstChild.textContent : '')`);
            await open();
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 5`, `${tag}: five welcome items`, 8000);
            const folderCount = () => ev(`[...document.querySelectorAll('.view-list-item')].filter(r => r.querySelector('.view-list-name, .view-list-label') && /Needs you$/.test(r.querySelector('.view-list-label').textContent.trim())).map(r => (r.querySelector('.view-list-count') || {}).textContent)`);
            const pills = () => ev(`[...document.querySelectorAll('button.goals-chip')].map(e => e.textContent.trim())`);
            const counts = await folderCount();
            check(counts.length > 0 && counts.every(c => !c || c === '0'), `${tag}: the Needs you folder does not count the five Getting started items (#19274): ` + JSON.stringify(counts));
            const chips = await pills();
            check(!chips.some(c => /^All\s*[1-9]/.test(c) || /^Welcome/.test(c)), `${tag}: All does not count the five, and there is no Welcome pill: ` + JSON.stringify(chips));
            const badge = () => ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent.trim()`);
            check(['', '0'].includes(await badge()), `${tag}: the badge does not count them: ` + await badge());
            const head = () => ev(`[...document.querySelectorAll('#group-table-view .dt-group')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            check((await head()).some(h => /^Getting started \u00b7 5\b/.test(h)), `${tag}: they sit under 'Getting started · 5': ` + JSON.stringify(await head()));
            const names = await ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].map(e => ({ t: e.firstChild ? e.firstChild.textContent : '', ws: getComputedStyle(e).whiteSpace, cut: e.scrollWidth > e.clientWidth + 1, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || 20)) }))`);
            check(names.length === 5 && names.every(n => n.ws === 'normal' && !n.cut), `${tag}: no welcome title is cut: ` + JSON.stringify(names));
            check(await ev(`!document.querySelector('.inbox-getting-started') && !document.querySelector('button[aria-label="Dismiss Getting started"]') && document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length === 5`), `${tag}: no separate block: the five are rows of the Needs you table`);
            // two agents waiting beside the five welcome items: the folder, the Inbox badge and the phone drawer's count are one number (#11622)
            await ev(`T.state.liveSessions = [0, 1].map(i => ({ name: 'w' + i, session_id: '0000000' + i + '-0000-4000-8000-0000000000aa', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Waiting ' + i, working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 300000).toISOString(), sleeping: false })); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return true; })`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, `${tag}: the badge says 2 (two waiting; the Getting started items are not counted)`, 8000);
            const mixedCounts = await folderCount();
            check(mixedCounts.length > 0 && mixedCounts.every(c => c === '2'), `${tag}: with two waiting the folder says 2, like the badge: ` + JSON.stringify(mixedCounts));
            { // header = All = the kind pills: the Getting started items are in none of them (#19274, #18023)
                const pill = await ev(`[...document.querySelectorAll('button.goals-chip')].map(e => e.textContent.trim().replace(/\\s+/g, ' '))`);
                const num = re => { const m = pill.map(t => re.exec(t)).find(Boolean); return m ? Number(m[1]) : null; };
                const kinds = pill.filter(t => !/^All\b/.test(t)).map(t => Number((/(\d+)\s*$/.exec(t) || [])[1] || 0)).reduce((a, b) => a + b, 0);
                check(num(/^All (\d+)/) === 2 && kinds === 2, `${tag}: All is 2 and the kind pills add up to it: ` + JSON.stringify(pill));
                check((await head()).some(h => /^Getting started \u00b7 4$/.test(h)), `${tag}: the four items are still under their heading: ` + JSON.stringify(await head()));
            }
            check(await ev(`import(${S} + 'inbox_tab.js').then(m => m.inboxCountsNow().needs === 2)`), `${tag}: the drawer's count is 2 too`);
            await ev(`T.state.liveSessions = []; T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return true; })`); // the agents go: the five items are back for the rest of the walk
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 5`, `${tag}: five welcome items again`, 8000);
            await shot(`inbox-welcome-counts-${w}`);
            await press(mobile ? 'Got it' : 'Dismiss', '#group-table-view button', 0);
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 4`, `${tag}: one item dismissed`, 8000);
            await waitFor(`[...document.querySelectorAll('#group-table-view .dt-group')].some(r => /Getting started \u00b7 4$/.test(r.textContent.trim()))`, `${tag}: the heading's count goes down with it`, 8000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await head())); });
            check(['', '0'].includes(await badge()), `${tag}: and the badge stays empty`);
        }
    } finally { try { await restoreLaunchNotice(ev); } catch (e) {} await settingsGuard.restore(); await client.close(); }
    if (found.length) { console.error(found.join('\n')); process.exit(1); }
    console.log('inbox_welcome_counts_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
