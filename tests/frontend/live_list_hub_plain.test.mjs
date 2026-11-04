// #13186: served through Coral Hub the dashboard's load asks the exact path /api/sessions/live, with no query (the Hub stamps only that path and does not take ?compact=1 yet); served by Coral itself it asks ?compact=1 (live_list_compact_ask.test.mjs).
//   node live_list_hub_plain.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'cloud' }); // served through Coral Hub: the Hub stamps only the exact path /api/sessions/live and does not take a query yet (#13186)
const asked = [];
globalThis.fetch = window.fetch = async (u) => {
    asked.push(String(u));
    if (/\/api\/health/.test(String(u))) return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify([{ session_id: 's1', agent_type: 'claude', name: 'a' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const api = await importUi('api');
const state = (await importUi('state')).state;
assert.equal(await api.loadLiveSessions(), true, 'the list loads');
const lists = asked.filter(u => /\/api\/sessions\/live(\?|$)/.test(u));
assert.deepEqual(lists, ['/api/sessions/live'], `through Coral Hub the load asks once, the exact path: ${JSON.stringify(asked)}`);
assert.equal(state.liveSessions.length, 1);
console.log('live_list_hub_plain: ok');
