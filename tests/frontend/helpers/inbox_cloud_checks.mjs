// The checks of inbox_cloud_native.test.mjs and inbox_cloud_default.test.mjs (Goal #100, #9542): a Hub-served dashboard with the boot value inbox:'native' draws the native Inbox with the chat folders only, reads
// the linked computers (never a "local" one) and drops the Chats and Board tabs; without the value nothing changes. One jsdom per process, so each file runs one of the two.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './jsdom_env.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'coral-go', 'pkg', 'frontend');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
export async function run(native) {
const dom = installDom({ mode: 'cloud', boot: native ? { inbox: 'native' } : {} });
try {
    const base = await importUi('server_base');
    assert.equal(base.isCloud(), true);
    assert.equal(base.nativeInbox(), native, native ? 'the boot value turns it on' : 'it is off until the Hub sets the boot value');

    const { state } = await importUi('state');
    state.hub = true;
    state.servers = [{ id: 'local', status: 'online' }, { id: 'box-2', status: 'online' }, { id: 'down', status: 'offline' }, { id: 'box-3', status: 'online' }];
    const { inboxSources, serverChoices } = await importUi('inbox_servers');
    assert.deepEqual(inboxSources(), ['box-2', 'box-3'], 'a Hub has no local computer: the sources are the online linked ones');
    assert.deepEqual(serverChoices(), ['box-2', 'down', 'box-3'], 'the choices are the linked computers');

    const calls = [];
    globalThis.fetch = window.fetch = async url => {
        const p = new URL(url, 'https://hub.example').pathname; calls.push(p);
        if (p.includes('/box-3/')) throw new Error('unreachable');
        if (p.endsWith('/api/sessions/history/counts')) return Response.json({ all: 4, group: 1, notes: 0, starred: 2, active: 1, archived: 0, by_agent_type: { claude: 4 }, tags: [{ id: 1, name: 'x', count: 1, color: '#fff' }] });
        if (p.endsWith('/api/sessions/history')) return Response.json({ sessions: [{ session_id: 's1', title: 'one', type: 'agent' }], total: 1 });
        return Response.json({});
    };
    const CH = await importUi('mailbox_chats');
    const counts = await CH.loadChatCounts();
    assert.equal(counts.all, 4, 'one computer that does not answer does not blank the others');
    assert.ok(calls.every(p => p.startsWith('/api/remote/')), `every read goes through the proxy of a linked computer: ${calls}`);
    assert.ok(!calls.includes('/api/sessions/history/counts'), 'nothing is asked of the Hub itself');
    const titles = CH.chatSections().map(s => s.title);
    assert.deepEqual(titles, native ? ['Chats', 'By CLI'] : ['Chats', 'By CLI', 'Tags'], native ? 'no Tags folder (tags are per computer)' : 'Tags as before');

    // nothing online: the folder says so
    state.servers = [{ id: 'local', status: 'online' }, { id: 'down', status: 'offline' }];
    assert.deepEqual(inboxSources(), []);
    const spec = CH.chatsSpec('chats', { query: '', params: {}, redraw() {}, open() {}, after() {} });
    spec.empty?.line; // the first read starts here
    await new Promise(r => setTimeout(r, 20));
    const again = CH.chatsSpec('chats', { query: '', params: {}, redraw() {}, open() {}, after() {} });
    assert.match(JSON.stringify(again), /No computers online\./, 'with no computer online the folder says so');

    // the Hub's three pages are frames at constant addresses (coral-hub's); the chat search runs on Enter
    const sidebar = read('static/inbox_sidebar.js');
    assert.match(sidebar, /const HUB_FRAMES = \{ needs: '\/inbox\/hub\/needs', tasks: '\/inbox\/hub\/tasks', saved: '\/inbox\/hub\/saved' \};/, 'the frame addresses are constants');
    assert.ok(!/setAttribute\('src', [^)]*(location|hash|search|\+)/.test(sidebar.slice(sidebar.indexOf('function hubFrameTable'), sidebar.indexOf("registerGroupSource('hub-inbox'"))), 'a frame address is never built');
    assert.match(sidebar, /commitOnEnter: nativeInbox\(\)/, 'a chat folder searches on Enter on a Hub');
    assert.match(read('static/list_bar.js'), /const typed = next => \{ if \(!spec\.commitOnEnter\) later\(next\); \}/);
    assert.match(read('static/app_actions.js'), /'inbox-search-filter': el => \{ if \(nativeInbox\(\)\) return;/);
    assert.match(sidebar, /async function openChat\(c\) \{\n    if \(nativeInbox\(\) && !c\.server\) return;/, 'on a Hub a chat row with no computer opens nothing (no fall back to local)');
    for (const f of ['inbox_sidebar.js', 'app_routes.js']) assert.ok(!read('static/' + f).includes("'chats-group'"), `${f} does not spell the Boards folder: routes.js owns the pair (BOARDS_FOLDER, BOARDS_SUB)`);
    // the tab, the hamburger and the More menu
    const tabs = ['nav-tab-history', 'nav-tab-board'].map(id => document.getElementById(id));
    for (const t of tabs) assert.ok(t && t.hasAttribute('data-native-inbox-hides'), `${t && t.id} is the switch's`);
    assert.match(read('static/css/cloud.css'), /body\.native-inbox \[data-native-inbox-hides\]\s*\{\s*display:\s*none\s*!important/);
    assert.match(read('static/nav_tabs.js'), /nativeInbox && el\.hasAttribute\('data-native-inbox-hides'\)/, 'the hamburger and the More menu leave them out');
    assert.match(read('static/cloud.js'), /if \(nativeInbox\(\)\) document\.body\.classList\.add\('native-inbox'\)/);
    // the one switch has these readers and no other
    const readers = fs.readdirSync(path.join(root, 'static')).filter(f => f.endsWith('.js') && /\bnativeInbox\b/.test(read('static/' + f))).sort();
    // (#9549 adds the entry points of the old Chats and Board addresses: app_navigation.js, app_routes.js and history_source.js)
    assert.deepEqual(readers, ['app_actions.js', 'app_navigation.js', 'app_routes.js', 'cloud.js', 'history_source.js', 'inbox_sidebar.js', 'inbox_tab.js', 'mailbox_chats.js', 'nav_tabs.js', 'server_base.js'], 'nativeInbox() is read in the planned places only');
    if (native) { // the real Inbox, drawn: the Hub's three pages and the chat folders, only the planned requests, a frame at its constant address
        state.servers = [{ id: 'box-2', status: 'online' }];
        calls.length = 0;
        globalThis.fetch = window.fetch = async url => { calls.push(new URL(url, 'https://hub.example').pathname); return Response.json(String(url).includes('counts') ? { all: 2, group: 0, notes: 0, starred: 0, active: 0, archived: 0, by_agent_type: {} } : { sessions: [], total: 0 }); };
        document.body.classList.add('cloud-mode', 'native-inbox'); document.body.setAttribute('data-nav-tab', 'hub-inbox');
        (await importUi('inbox_tab')).showInboxTabContent();
        const settle = async ms => { await new Promise(r => setTimeout(r, ms)); };
        await settle(1500);
        assert.ok(!document.getElementById('inbox-frame'), 'no frame for the whole tab: the Inbox is drawn');
        const nav = () => [...document.querySelectorAll('#inbox-nav-list button')];
        const words = nav().map(b => b.textContent.replace(/^[a-z_]+(?=[A-Z])/, '').trim());
        for (const w of ['Needs you', 'Tasks', 'Saved for later', 'All chats2', 'Board history0', 'Starred0']) assert.ok(words.includes(w), `${w} is in the folder list: ${words}`);
        for (const w of ['Goals', 'Artifacts', 'Saved']) assert.ok(!words.some(x => x === w || x.startsWith(w + ' ') && !x.startsWith('Saved for')), `${w} is not a cloud folder`);
        nav().find(b => /Needs you/.test(b.textContent)).click(); await settle(300);
        const frame = document.querySelector('#group-table-view iframe');
        assert.equal(frame && frame.getAttribute('src'), '/inbox/hub/needs', 'Needs you is the Hub page, at its constant address');
        assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer'); assert.equal(frame.getAttribute('allow'), '');
        assert.equal(document.getElementById('inbox-search').disabled, true, 'a Hub page has its own search');
        nav().find(b => /Starred/.test(b.textContent)).click(); await settle(300);
        assert.equal(document.getElementById('inbox-search').disabled, false);
        // Enter in the Inbox's search sends ONE read of each online computer, and the same words again send one again (#9574: a kept list answered them with no request)
        const sb = await importUi('inbox_sidebar');
        const histReads = () => calls.filter(c => c === '/api/remote/box-2/api/sessions/history').length;
        calls.length = 0; sb.filterInbox('needle'); await settle(300);
        assert.equal(histReads(), 1, `Enter sends one read of the one online computer: ${calls}`);
        calls.length = 0; sb.filterInbox('needle'); await settle(300);
        assert.equal(histReads(), 1, `the same words again send one more: ${calls}`);
        // a held Enter (keydown repeats about 30 times a second) is ONE search, from either field; only the searched folder's kept list is forgotten
        for (const id of ['inbox-search', 'inbox-chats-search']) {
            const box = document.getElementById(id); box.value = 'held ' + id; calls.length = 0;
            const key = repeat => box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat }));
            key(false); for (let i = 0; i < 30; i++) key(true);
            await settle(300);
            assert.equal(histReads(), 1, `a held Enter in #${id} sends one read, not thirty: ${calls.length} requests`);
        }
        const CHm = await importUi('mailbox_chats');
        assert.equal(typeof CHm.resetChatLists, 'function'); CHm.resetChatLists('chats-archived'); // another folder's reset does not touch the folder on screen
        calls.length = 0; await settle(100); assert.equal(histReads(), 0, 'forgetting another folder reads nothing');
        const ok = new Set(['/api/remote/box-2/api/sessions/history/counts', '/api/remote/box-2/api/sessions/history']);
        assert.ok(calls.every(c => ok.has(c)), `only the chat folders are read: ${[...new Set(calls)]}`);
    }
    console.log(`inbox_cloud_native: ok (${native ? 'native' : 'default'})`);
} finally { dom.window.close(); setTimeout(() => process.exit(process.exitCode || 0), 50).unref?.(); }
}
