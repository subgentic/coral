// The checks of native_inbox_addresses.test.mjs and native_inbox_default_addresses.test.mjs (Goal #100, #9549): on a Hub-served dashboard with the boot value inbox:'native' the old Chats and Board entry points
// lead to the Inbox, never to a Chats tab that is not there and never to a not-found page; without the value the Chats addresses are what they were. One jsdom per process, so each file runs one of the two.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './jsdom_env.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'coral-go', 'pkg', 'frontend');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
export async function run(native) {
    installDom({ mode: 'cloud', boot: native ? { inbox: 'native' } : {} });
    const { state } = await importUi('state');
    state.hub = true;
    state.servers = [{ id: 'local', status: 'online' }, { id: 'box-2', status: 'online' }];
    const { historyRoute } = await importUi('history_source');
    state.historySourceServer = 'box-2';
    if (native) {
        // the address a chat or the chat list gets (what the Inbox notes when a chat opens)
        assert.deepEqual(historyRoute('abc-123'), { view: 'inbox-folder', folder: 'chats', server: 'box-2', id: 'abc-123' }, 'a chat opened in the Inbox has an Inbox address, with its computer');
        assert.deepEqual(historyRoute(null, ''), { view: 'inbox-folder', folder: 'chats' }, 'the chat list is All chats');
        assert.deepEqual(historyRoute(null, 'type=group'), { view: 'inbox-boards', sub: 'boards' }, 'the group filter is the Boards folder');
        // the entry points are wired where the plan names them (read from source: the handlers need the whole page)
        assert.match(read('static/app_routes.js'), /route\('chats', async \(r, opts\) => \{\s*if \(nativeInbox\(\)\) return go\(inboxRouteFor\(r\), \{ replace: true \}\);/, 'the /chats handler redirects first, before it reads anything');
        assert.match(read('static/app_routes.js'), /route\('inbox-folder', async r => \{[\s\S]{0,200}if \(r\.id\) \{/, 'the Inbox folder handler opens a chat that has an id');
        assert.match(read('static/app_navigation.js'), /toBoards = tab === 'board' && nativeInbox\(\), chatsInInbox = \(tab === 'history' && \(!isCloud\(\) \|\| nativeInbox\(\)\)\) \|\| toBoards;/, 'the Chats and Board tabs open the Inbox');
        const html = read('templates/index.html');
        for (const id of ['nav-tab-history', 'nav-tab-board']) assert.match(html, new RegExp(`<button[^>]*data-native-inbox-hides[^>]*id="${id}"|<button[^>]*id="${id}"[^>]*data-native-inbox-hides`), `the ${id} tab goes with the switch`);
    } else {
        assert.deepEqual(historyRoute('abc-123'), { view: 'chats', id: 'abc-123', server: 'box-2' }, 'without the value a chat keeps its Chats address');
        assert.deepEqual(historyRoute(null, 'type=group'), { view: 'chats', query: 'type=group', server: 'box-2' }, 'and the list its own');
    }
    console.log(`native_inbox_addresses (${native ? 'native' : 'default'}): ok`);
}
