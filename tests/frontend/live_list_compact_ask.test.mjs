// #13186: the dashboard's own load of the live list asks for the compact shape (?compact=1: no keys whose value is null) when it is served by Coral itself, and what it gets replaces its list. Through Coral Hub it asks the exact path (live_list_hub_plain.test.mjs).
//   node live_list_compact_ask.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
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
assert.deepEqual(lists, ['/api/sessions/live?compact=1'], `the load asks once, for the compact shape: ${JSON.stringify(asked)}`);
assert.equal(state.liveSessions.length, 1);
console.log('live_list_compact_ask: ok');
