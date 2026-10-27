// Goal #100 slice 0 (task #9541, plan coral://artifacts/5bbb7ea4bf849bf250fe84f1552b703c7f77fbbcbd4401a6bc08021f40e2bde5): the request census of the native Inbox in cloud mode. Through Coral Hub the Inbox reads
// the Chats folders and the boards of every online computer, and nothing else; the Hub classifies the routes it proxies, so this list is a contract with it: the routes and query keys the cloud Inbox sends
// beyond what the cloud Chats and Board tabs already send are ONE route (GET /api/sessions/history/counts) and FIVE keys (starred, archived, active, with_notes on /api/sessions/history; agent_name, from the Filters'
// Agent field). The census drives the Chats tab and the team page's Board tab as the Hub's dashboard has them (the baseline), then drives the Inbox's chat folders the way the Inbox does, in the Hub's stubbed
// two-computer world (helpers/hub_world.js), records every request (method, path, query keys) and fails on any route or key that is not the baseline plus those. It also holds the read-only claim (no request but a
// GET), the "not called in cloud mode" list of the plan, and, once the Inbox stops asking the Hub itself for a Chats history it does not have (the plan's risk 1: inboxSources() lists 'local'), that no unproxied history read is made.
const assert = require('node:assert/strict');
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
// What the dashboard itself asks the Hub for whatever tab is open (the stub's own answers): not the Inbox's, not counted.
const PAGE_CHROME = new Set(['/auth/session', '/api/account', '/api/sessions/live', '/api/servers', '/api/settings']);

const norm = p => p.replace(/^\/api\/remote\/[^/]+/, '').replace(/\/sessions\/history\/(?!counts$|search$)[^/]+(\/|$)/, (m, b) => `/sessions/history/{id}${b}`);

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
    const shape = reqs => reqs.filter(r => !PAGE_CHROME.has(r.p)).map(r => ({ proxied: /^\/api\/remote\//.test(r.p), m: r.m, p: norm(r.p), keys: r.keys }));
    const keysByPath = reqs => { const out = new Map(); for (const r of reqs) { const s = out.get(`${r.m} ${r.p}`) || new Set(); r.keys.forEach(k => s.add(k)); out.set(`${r.m} ${r.p}`, s); } return out; };
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: RECORDER });

        // 1. the baseline: the cloud Chats tab, and the team page's Board tab, as the Hub's dashboard has them
        await open('/');
        await take();
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
        const baseline = new Map();
        for (const [k, keys] of keysByPath([...chatsTab, ...boardTab])) baseline.set(k, keys);
        const hk = baseline.get('GET /api/sessions/history') || new Set(); HISTORY_KEYS.forEach(k => hk.add(k)); baseline.set('GET /api/sessions/history', hk); // the plan's list of what the Chats tab sends
        assert.ok(baseline.has('GET /api/sessions/history') && [...baseline.keys()].some(k => /\/messages\/all$/.test(k)), 'the baseline has the Chats tab and the Board tab: ' + JSON.stringify([...baseline.keys()]));
        assert.ok(![...baseline.keys()].includes(`GET ${ADDED_ROUTE}`) , 'the Chats and Board tabs do not call the counts route');

        // 2. the Inbox's chat folders, the way the Inbox reads them: the counts, every folder (and the CLI folders) on its first page, the Filters' parameters, a search, and a chat from a folder
        await open('/');
        await take();
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
            m.chatsSpec('chats', ctx({}, 'needle')); await window.__quiet();
            // a chat from a folder opens in the Chats viewer
            window.selectHistorySession?.('same-chat', null, { session_id: 'same-chat', server: 'm1', source_type: 'claude', title: 'Laptop conversation' }); await window.__quiet();
            return { cloud: sv.isCloud(), nativeInbox: typeof sv.nativeInbox === 'function' ? !!sv.nativeInbox() : null, frame: !!document.getElementById('inbox-frame') };
        })()`);
        assert.equal(driven.cloud, true, 'the page is in cloud mode');
        // and the Inbox tab itself, where the dashboard draws the native Inbox in cloud mode (slice 1): every folder of its list is opened. Until then it is the Hub's frame and has nothing to open.
        let tabbed = [];
        await ev(`window.switchNavTab('hub-inbox'); true`); await ev(`window.__quiet()`);
        const ui = await ev(`(() => ({ frame: !!document.getElementById('inbox-frame'), local: !!document.getElementById('inbox-local') && !document.getElementById('inbox-local').hidden, folders: [...document.querySelectorAll('#inbox-folders [data-key], #inbox-folders button, #inbox-folders [role=option]')].length }))()`);
        if (ui.local && ui.folders > 0) {
            const n = ui.folders;
            for (let i = 0; i < n; i++) { await ev(`(() => { const els = [...document.querySelectorAll('#inbox-folders [data-key], #inbox-folders button, #inbox-folders [role=option]')]; els[${i}] && els[${i}].click(); return true; })()`); await ev(`window.__quiet()`); }
            tabbed = ['the Inbox tab was driven: ' + n + ' folders'];
        } else console.log('   (the cloud Inbox tab is still the Hub frame: ' + JSON.stringify(ui) + '; the folders were driven through their module)');
        const inbox = shape(await take());

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
        // risk 1 (plan section 5): the Inbox's source list includes 'local', which in the Hub is the Hub itself: it has no history. Counted and said now; strict once slice 1 lands (nativeInbox exists).
        if (driven.nativeInbox !== null) assert.deepEqual(unproxied.map(r => `${r.m} ${r.p}`), [], 'with the native cloud Inbox no history read is made of the Hub itself (the online computers only)');
        else console.log(`   (plan risk 1, until slice 1: ${unproxied.length} history reads went to the Hub itself, not through a computer)`);
        console.log(`   ${inbox.length} Inbox requests: ${proxied.length} through the Hub, in ${new Set(proxied.map(r => r.p)).size} routes; ${tabbed.join('; ') || 'folders driven through the module'}`);
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
