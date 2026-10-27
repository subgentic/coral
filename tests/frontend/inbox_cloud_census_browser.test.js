// Goal #100 slice 0 (task #9541, plan coral://artifacts/5bbb7ea4bf849bf250fe84f1552b703c7f77fbbcbd4401a6bc08021f40e2bde5): the request census of the native Inbox in cloud mode. Through Coral Hub the Inbox reads
// the Chats folders and the boards of every online computer, and nothing else; the Hub classifies the routes it proxies, so this list is a contract with it: the routes and query keys the cloud Inbox sends
// beyond what the cloud Chats and Board tabs already send are ONE route (GET /api/sessions/history/counts) and FIVE keys (starred, archived, active, with_notes on /api/sessions/history; agent_name, from the Filters'
// Agent field). The census drives the Chats tab and the team page's Board tab as the Hub's dashboard has them (the baseline), then drives the Inbox's chat folders the way the Inbox does, in the Hub's stubbed
// two-computer world (helpers/hub_world.js), records every request (method, path, query keys) and fails on any route or key that is not the baseline plus those. It also holds the read-only claim (no request but a
// GET), the "not called in cloud mode" list of the plan, and, once the Inbox stops asking the Hub itself for a Chats history it does not have (the plan's risk 1: inboxSources() lists 'local'), that no unproxied history read is made.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { nextFrame } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

// The routes the Chats and Board tabs already call through the Hub (plan section 3: "already sent by the Chats tab"); the history route's keys are listed as the plan lists them.
const HISTORY_KEYS = ['type', 'source_types', 'date_from', 'date_to', 'q', 'page', 'page_size', 'fts_mode'];
// What the plan adds (section 3, rows 1 to 6).
const ADDED_ROUTE = '/api/sessions/history/counts';
const ADDED_KEYS = ['active', 'agent_name', 'archived', 'starred', 'with_notes'];
// The plan's "not called in cloud mode" list: none of these is asked for through the Hub by this Inbox.
const NOT_CALLED = [/^\/api\/goals(\/|$)/, /^\/api\/team-artifacts(\/|$)/, /^\/api\/saved(\/|$)/, /^\/api\/board\/tasks$/, /^\/api\/scheduled\/runs\/recent$/, /^\/api\/workflows\/runs\/recent$/, /^\/api\/artifacts\//,
    /\/tasks\/\d+\/reply$/, /^\/api\/sessions\/history\/[^/]+\/flags$/];
// The routes the Chats and Board tabs call through the Hub, FIXED here (not recorded from the tabs in the same run: a key added to those tabs must fail, not widen the baseline). Placeholders: {id} a chat,
// {team} a board. The history routes' keys are the plan's list; the rest is what the tabs send in the Hub's stubbed world (recorded once, 2026-10-27, main 9f9e5c7b5 and after).
const BASELINE = Object.fromEntries(Object.entries({
    '/api/sessions/history': HISTORY_KEYS, '/api/sessions/history/search': HISTORY_KEYS, '/api/sessions/history/{id}': ['limit'], '/api/sessions/history/{id}/agent-notes': [], '/api/sessions/history/{id}/events': ['limit'],
    '/api/sessions/history/{id}/git': [], '/api/sessions/history/{id}/notes': [], '/api/sessions/history/{id}/tags': [], '/api/sessions/history/{id}/tasks': [], '/api/sessions/{id}/changes': [], '/api/tags': [], '/api/token-usage': ['session_id'],
    '/api/board/projects': [], '/api/board/{team}': [], '/api/board/{team}/artifacts': ['limit'], '/api/board/{team}/goals': ['limit', 'state'], '/api/board/{team}/messages/all': ['format', 'limit', 'offset'], '/api/board/{team}/paused': [],
    '/api/board/{team}/status': [], '/api/board/{team}/subscribers': [], '/api/board/{team}/tasks': ['counts'], '/api/sessions/live/team/{team}/sleep-status': [], '/api/teams/detail/{team}/knowledge': [],
}).map(([k, v]) => [`GET ${k}`, v]));
// What the dashboard itself asks the Hub (not through a computer) at boot and while a tab is open: counted and pinned too, so a new one from the Inbox shows. Keys are none but the ones listed.
const CHROME = {
    'GET /auth/session': [], 'GET /api/account': [], 'GET /api/folder-tags': [], 'GET /api/pinned-folders': [], 'GET /api/scheduled/jobs': [], 'GET /api/servers': [], 'GET /api/sessions/live': [], 'GET /api/settings': [],
    'GET /api/system/status': [], 'GET /api/system/update-check': [], 'GET /api/views': [], 'POST /api/tracking/event': [],
};

const norm = p => p.replace(/^\/api\/remote\/[^/]+/, '').replace(/\/sessions\/history\/(?!counts$|search$)[^/]+(\/|$)/, (m, b) => `/sessions/history/{id}${b}`)
    .replace(/^\/api\/sessions\/(?!history|live)[^/]+\/changes$/, '/api/sessions/{id}/changes').replace(/^\/api\/board\/(?!projects|tasks|remotes)[^/]+/, '/api/board/{team}')
    .replace(/^\/api\/sessions\/live\/team\/[^/]+\//, '/api/sessions/live/team/{team}/').replace(/^\/api\/teams\/detail\/[^/]+\//, '/api/teams/detail/{team}/');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
        const RECORDER = `(() => { const inner = window.fetch; window.__census = []; window.fetch = function (u, o = {}) { try { const url = new URL(String(u), location.href);
        window.__census.push({ m: (o.method || 'GET').toUpperCase(), p: url.pathname, keys: [...new Set([...url.searchParams.keys()])].sort() }); } catch (e) {} return inner.call(this, u, o); };
        window.__quiet = async () => { let n = -1, still = 0; while (still < 5) { await new Promise(r => setTimeout(r, 50)); if (window.__census.length === n) still++; else { still = 0; n = window.__census.length; } } }; })();`;
    const take = () => ev(`(() => { const r = window.__census.slice(); window.__census.length = 0; return r; })()`);
    const open = async (url) => {
        await Page.navigate({ url: BASE + url }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
    };
    // the requests as a set of "METHOD path ?keys", the page's own chrome left out and a computer's id replaced
    const shape = reqs => reqs.map(r => { const proxied = /^\/api\/remote\//.test(r.p), p = norm(r.p); return { proxied, m: r.m, p, keys: r.keys, chrome: !proxied && `${r.m} ${p}` in CHROME }; });
    // the requests that are neither the fixed baseline's (through a computer) nor the dashboard's own: the fixed lists above are the whole allowance
    const outsideBaseline = (reqs, { localHistory = false } = {}) => reqs.filter(r => r.m !== 'MARK').flatMap(r => {
        const key = `${r.m} ${r.p}`;
        if (r.chrome) return r.keys.filter(k => !CHROME[key].includes(k)).map(k => `${key} ?${k} (the dashboard's own request sent a new key)`);
        if (r.proxied) return !(key in BASELINE) ? [`${key} is not a route of the fixed baseline`] : r.keys.filter(k => !BASELINE[key].includes(k)).map(k => `${key} ?${k} is not a key of the fixed baseline`);
        if (localHistory && /^\/api\/sessions\/history(\/|$)/.test(r.p)) return []; // plan risk 1, counted below
        return [`${key} is a request to the Hub itself that is not the dashboard's own`];
    });
    const keysByPath = reqs => { const out = new Map(); for (const r of reqs) { const s = out.get(`${r.m} ${r.p}`) || new Set(); r.keys.forEach(k => s.add(k)); out.set(`${r.m} ${r.p}`, s); } return out; };
    try {
        let bootNative = false; // the Hub's boot value for the Inbox: off while the baseline is recorded (the Chats and Board tabs as the Hub has them), on for the Inbox
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: () => bootNative, hubPages: !!process.env.INBOX_CENSUS_SHOTS }); // the stand-in Hub page only for the pictures: a run without them answers the Hub's own pages as the isolated server does
        await Page.addScriptToEvaluateOnNewDocument({ source: RECORDER });

        // 1. the baseline: the cloud Chats tab, and the team page's Board tab, as the Hub's dashboard has them
        await open('/');
        const bootA = shape(await take());
        await ev(`window.switchNavTab('history'); true`);
        await waitFor(`window.__census.some(r => /\\/api\\/sessions\\/history$/.test(r.p))`, 'the Chats tab reads the history', 15000);
        await ev(`window.__quiet()`);
        await ev(`(window.selectHistorySession && window.selectHistorySession('same-chat', null, { session_id: 'same-chat', server: 'm1', source_type: 'claude', title: 'Laptop conversation' })), true`);
        await ev(`window.__quiet()`);
        const chatsTab = shape(await take());
        await open('/team/@m1/same-team/board');
        await waitFor(`location.pathname === '/team/@m1/same-team/board'`, 'the Board tab', 15000);
        await waitFor(`window.__census.some(r => /\\/messages\\/all$/.test(r.p))`, 'the board read', 15000);
        await ev(`window.__quiet()`);
        const boardTab = shape(await take());
        // the tabs send nothing beyond the fixed baseline (and the dashboard's own chrome): a new route or key on the Chats or Board tab fails here, before the Inbox is looked at
        const tabsOutside = outsideBaseline([...bootA, ...chatsTab, ...boardTab]);
        assert.deepEqual(tabsOutside, [], 'the Chats and Board tabs stay inside the fixed baseline: ' + JSON.stringify(tabsOutside));
        assert.ok(chatsTab.some(r => r.p === '/api/sessions/history') && boardTab.some(r => /\/messages\/all$/.test(r.p)), 'the baseline was driven: the Chats tab and the Board tab read');
        assert.ok(![...chatsTab, ...boardTab].some(r => r.p === ADDED_ROUTE), 'the Chats and Board tabs do not call the counts route');
        const baseline = new Map(Object.entries(BASELINE).map(([k, keys]) => [k, new Set(keys)]));

        // 2. the Inbox's chat folders, the way the Inbox reads them: the counts, every folder (and the CLI folders) on its first page, the Filters' parameters, a search, and a chat from a folder
        bootNative = true;
        await open('/');
        const bootInbox = shape(await take());
        const driven = await ev(`(async () => {
            const m = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js');
            const sv = await import((window.__coralStatic || '/static/') + 'server_base.js');
                        const ctx = (params = {}, query = '') => ({ query, params, open() {}, redraw() {}, after() {} });
            await m.loadChatCounts(() => {});
            const folders = ['chats', 'chats-group', 'chats-notes', 'chats-starred', 'chats-active', 'chats-archived', 'chats-cli-claude', 'chats-cli-codex', 'chats-cli-agy', 'chats-cli-pi'];
            for (const k of folders) { m.chatsSpec(k, ctx()); await window.__quiet(); }
            // the Filters (chat_filters.js toParams): CLI, Agent, dates; Tags is left out of the cloud Inbox
            m.chatsSpec('chats', ctx({ agent_name: 'Review agent' })); await window.__quiet();
            m.chatsSpec('chats', ctx({ date_from: '2026-10-01', date_to: '2026-10-27' })); await window.__quiet();
            m.chatsSpec('chats', ctx({ source_types: 'claude' })); await window.__quiet();
            m.chatsSpec('chats-starred', ctx({ agent_name: 'Docs agent', date_from: '2026-10-01' })); await window.__quiet();
            // typing in the search box: the Inbox asks for the list again with the text as typed, key by key (a person types about every 100 ms; the marks bound what the typing sent)
            window.__census.push({ m: 'MARK', p: 'typing-module', keys: [] });
            for (let i = 1; i <= 'needle'.length; i++) { m.chatsSpec('chats', ctx({}, 'needle'.slice(0, i))); await new Promise(r => setTimeout(r, 30)); }
            await window.__quiet();
            window.__census.push({ m: 'MARK', p: 'typed-module', keys: [] });
            // a chat from a folder opens in the Chats viewer
            window.selectHistorySession?.('same-chat', null, { session_id: 'same-chat', server: 'm1', source_type: 'claude', title: 'Laptop conversation' }); await window.__quiet();
            return { cloud: sv.isCloud(), nativeInbox: typeof sv.nativeInbox === 'function' ? !!sv.nativeInbox() : null, frame: !!document.getElementById('inbox-frame') };
        })()`);
        assert.equal(driven.cloud, true, 'the page is in cloud mode');
        // and the Inbox tab itself, where the dashboard draws the native Inbox in cloud mode (slice 1): every folder of its list is opened. Until then it is the Hub's frame and has nothing to open.
        let tabbed = [];
        const fieldsTyped = [];
        await ev(`window.__census.push({ m: 'MARK', p: 'ui-open', keys: [] }); window.switchNavTab('hub-inbox'); true`); await ev(`window.__quiet()`);
        const ui = await ev(`(() => ({ frame: !!document.getElementById('inbox-frame'), local: !!document.getElementById('inbox-local') && !document.getElementById('inbox-local').hidden, folders: [...document.querySelectorAll('#inbox-nav-list button')].length }))()`);
        if (ui.local && ui.folders > 0) {
            const n = ui.folders;
            for (let i = 0; i < n; i++) { await ev(`(() => { const els = [...document.querySelectorAll('#inbox-nav-list button')]; els[${i}] && els[${i}].click(); return true; })()`); await ev(`window.__quiet()`); }
            tabbed = ['the Inbox tab was driven: ' + n + ' folders'];
            // the Inbox's two search fields, each typed in key by key on a chat folder and then committed with Enter: the sidebar's box (its action is inbox-search-filter, app_actions.js) and the table toolbar's field
            await ev(`(() => { const all = [...document.querySelectorAll('#inbox-nav-list button')].find(b => /all chats/i.test(b.textContent)); all && all.click(); return true; })()`); await ev(`window.__quiet()`);
            for (const [i, [id, label]] of [['inbox-search', 'the sidebar box'], ['inbox-chats-search', 'the toolbar field']].entries()) {
                // empty first (the two fields share one search), outside the marks; then focus
                const found = await ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e || !e.getClientRects().length) return false; e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.focus(); return true; })()`);
                assert.equal(found, true, `the Inbox has ${label} (#${id})`);
                await ev(`window.__quiet()`);
                await ev(`window.__census.push({ m: 'MARK', p: 'typing-${i}', keys: [] }); true`);
                for (const ch of 'needle') { await client.Input.insertText({ text: ch }); await new Promise(r => setTimeout(r, 40)); }
                await ev(`window.__quiet()`);
                await ev(`window.__census.push({ m: 'MARK', p: 'typed-${i}', keys: [] }); true`);
                for (const type of ['keyDown', 'keyUp']) await client.Input.dispatchKeyEvent({ type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
                await ev(`window.__quiet()`);
                await ev(`window.__census.push({ m: 'MARK', p: 'entered-${i}', keys: [] }); true`);
                // a held Enter (the key repeats while it is down) is one search, not one per repeat
                await ev(`window.__census.push({ m: 'MARK', p: 'holding-${i}', keys: [] }); true`);
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
                for (let r = 0; r < 8; r++) { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', autoRepeat: true }); await new Promise(res => setTimeout(res, 30)); }
                await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
                await ev(`window.__quiet()`);
                await ev(`window.__census.push({ m: 'MARK', p: 'held-${i}', keys: [] }); true`);
                fieldsTyped.push({ label, i });
            }
            tabbed.push('a 6-letter search was typed into the Inbox\'s sidebar box and its toolbar field, each committed with Enter');
        } else console.log('   (the cloud Inbox tab is still the Hub frame: ' + JSON.stringify(ui) + '; the folders were driven through their module)');
        const inboxAll = shape(await take());
        const between = (a, b) => { const from = inboxAll.findIndex(r => r.m === 'MARK' && r.p === a), to = inboxAll.findIndex(r => r.m === 'MARK' && r.p === b); return from >= 0 && to > from ? inboxAll.slice(from + 1, to) : null; };
        const fieldRuns = fieldsTyped.map(f => ({ ...f, typed: between(`typing-${f.i}`, `typed-${f.i}`), entered: between(`typed-${f.i}`, `entered-${f.i}`), held: between(`holding-${f.i}`, `held-${f.i}`) })), typing = between('typing-module', 'typed-module'), inbox = inboxAll.filter(r => r.m !== 'MARK');
        assert.ok(typing, 'the typing was bounded by its marks');
        const online = await ev(`window.__computers.filter(c => c.online).length`);
        // then the Inbox is left alone for 30 seconds: no timer of the Inbox asks the computers again (the idle census below)
        await new Promise(r => setTimeout(r, 30000)); // sleep-ok: the observation is that nothing happens in 30 s (coral-hub Security's condition), there is no event to wait for
        const idle = shape(await take());

        // 3. the census
        const unproxied = inbox.filter(r => !r.proxied && /^\/api\/sessions\/history(\/|$)/.test(r.p));
        const proxied = inbox.filter(r => r.proxied);
        assert.deepEqual(proxied.filter(r => r.m !== 'GET').map(r => `${r.m} ${r.p}`), [], 'read-only: the Inbox sends nothing but GET through the Hub');
        const stray = [], newKeys = new Set(), newRoutes = new Set();
        for (const [route, keys] of keysByPath(proxied)) {
            const base = baseline.get(route);
            if (!base) { if (route === `GET ${ADDED_ROUTE}`) { newRoutes.add(route); if (keys.size) stray.push(`${route} sent keys ${[...keys]}`); } else stray.push(`${route} is not a route the Chats and Board tabs call, nor the plan's`); continue; }
            for (const k of keys) if (!base.has(k)) { if (route === 'GET /api/sessions/history' && ADDED_KEYS.includes(k)) newKeys.add(k); else stray.push(`${route} ?${k} is not a key of the baseline or the plan`); }
        }
        assert.deepEqual(stray, [], 'every request is the baseline or the plan\'s: ' + JSON.stringify(stray));
        assert.deepEqual([...newRoutes], [`GET ${ADDED_ROUTE}`], 'the one route beyond the Chats and Board tabs is the counts route');
        assert.deepEqual([...newKeys].sort(), ADDED_KEYS, 'the five keys beyond the Chats and Board tabs are starred, archived, active, with_notes and agent_name');
        for (const r of inbox) for (const re of NOT_CALLED) assert.ok(!re.test(r.p), `${r.m} ${r.p} is on the plan's list of what the cloud Inbox does not call`);
        assert.ok(!inbox.some(r => r.keys.includes('tag_ids')), 'no tag_ids: the Tags folder is left out of the cloud Inbox');
        assert.ok(proxied.length >= 10, 'computers were asked: ' + proxied.length);
        // the dashboard's own routes are counted: every one is on the fixed list with its keys, and the Inbox asks the Hub for nothing else, but the history reads of risk 1 below
        const hubOwn = [...bootInbox, ...inbox].filter(r => !r.proxied), chromeSeen = hubOwn.filter(r => r.chrome), chromeOutside = outsideBaseline(hubOwn, { localHistory: true });
        assert.deepEqual(chromeOutside, [], 'the requests to the Hub itself are the dashboard\'s own, from the fixed list: ' + JSON.stringify(chromeOutside));
        // coral-hub Security's conditions (#9551): the counts are read once per online computer per Inbox open, never polled; and typing in the search does not send the text, key by key, to the history list
        // (a typed search goes to /api/sessions/history/search).
        const uiAt = inboxAll.findIndex(r => r.m === 'MARK' && r.p === 'ui-open');
        const isCounts = r => r.proxied && r.p === ADDED_ROUTE;
        const byModule = inboxAll.slice(0, uiAt).filter(isCounts), byTab = inboxAll.slice(uiAt).filter(isCounts);
        assert.equal(byModule.length, online, `one read of the counts reads each online computer once (${byModule.length} reads, ${online} computers online)`);
        if (ui.local) assert.equal(byTab.length, online, `showing the Inbox tab reads the counts once per online computer, and opening every folder and typing a search reads them no more (${byTab.length} reads, ${online} computers online)`);
        const polled = idle.filter(r => /^\/api\/sessions\/history(\/|$)/.test(r.p));
        assert.deepEqual(polled.map(r => `${r.m} ${r.p}`), [], 'idle for 30 seconds: no history read at all, so no polling of the counts or the lists');
        const isHistory = r => /^\/api\/sessions\/history(\/|$)/.test(r.p), withText = r => r.p === '/api/sessions/history' && r.keys.some(k => ['q', 'page_size', 'fts_mode'].includes(k));
        const keystroke = typing.filter(withText);
        if (driven.nativeInbox !== null && fieldRuns.length) {
            // typing sends nothing to the history routes, key by key, from either field; Enter commits the search: exactly one history read with q per online computer per Enter (a read per source, not per key; coral-hub's promise, #9574)
            const report = [];
            for (const f of fieldRuns) {
                assert.deepEqual(f.typed.filter(isHistory).map(r => `${r.m} ${r.p} ?${r.keys}`), [], `typing in ${f.label} sends nothing to the history routes, key by key`);
                const reads = f.entered.filter(r => r.proxied && withText(r)), local = f.entered.filter(r => !r.proxied && isHistory(r));
                assert.equal(reads.length, online, `Enter in ${f.label} sends exactly one history read with q per online computer (${reads.length} reads, ${online} computers online): ${JSON.stringify(reads.map(r => r.keys))}`);
                assert.deepEqual(local.map(r => `${r.m} ${r.p}`), [], `Enter in ${f.label} reads no history from the Hub itself`);
                const heldReads = f.held.filter(r => r.proxied && withText(r));
                assert.equal(heldReads.length, online, `a held Enter in ${f.label} (a keydown and eight repeats) is one search: one history read with q per online computer (${heldReads.length} reads, ${online} computers online)`);
                report.push(`${f.label}: Enter sent ${reads.length} history reads with q (${online} computers)`);
            }
            console.log('   (' + report.join('; ') + ')');
        } else console.log(`   (until slice 1: typing a 6-letter search through the list's own reader sent ${keystroke.length} history reads with q and page_size and none to the search route (a model of the typing: the native Inbox's fields are typed into for real once the Hub's boot value is on); plan condition from coral-hub Security)`);
        // risk 1 (plan section 5): the Inbox's source list includes 'local', which in the Hub is the Hub itself: it has no history. Counted and said now; strict once slice 1 lands (nativeInbox exists).
        if (driven.nativeInbox !== null) assert.deepEqual(unproxied.map(r => `${r.m} ${r.p}`), [], 'with the native cloud Inbox no history read is made of the Hub itself (the online computers only)');
        else console.log(`   (plan risk 1, until slice 1: ${unproxied.length} history reads went to the Hub itself, not through a computer)`);
        console.log(`   ${inbox.length} Inbox requests: ${proxied.length} through the Hub, in ${new Set(proxied.map(r => r.p)).size} routes; ${chromeSeen.length} of the dashboard's own, in ${new Set(chromeSeen.map(r => r.m + r.p)).size} routes; ${tabbed.join('; ') || 'folders driven through the module'}`);
        // INBOX_CENSUS_SHOTS=<dir>: a picture of the Hub's Inbox with a framed group open (Needs you, the Hub's own page in the centre) at 1280 and at 390 px; the batch never takes them (UI/UX's #9644)
        if (process.env.INBOX_CENSUS_SHOTS) {
            const dir = process.env.INBOX_CENSUS_SHOTS;
            fs.mkdirSync(dir, { recursive: true });
            for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                bootNative = true;
                await open('/');
                await take();
                await ev(`window.switchNavTab('hub-inbox'); true`);
                await ev(`window.__quiet()`);
                await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('needs')).then(() => true)`);
                await waitFor(`!!document.querySelector('.inbox-frame') && document.querySelector('.inbox-frame').getClientRects().length > 0`, 'the framed Hub group', 8000);
                await nextFrame(ev);
                fs.writeFileSync(`${dir}/hub-inbox-framed-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            }
        }
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
