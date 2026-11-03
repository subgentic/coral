// A refusal for the refresh that arrives after another agent was opened draws nothing on it (#12650, UX/UX Engineer's point on #12646's View-mode block): agent A's refresh is refused for the mode while
// the person has already opened agent B; the 403 is read after the switch, and used to set A's block and draw its "This computer is in View mode" note on B's list.
//   node files_refresh_403_other_agent.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'cloud' });
const { state } = await importUi('state');
const cf = await importUi('changed_files');
const doc = dom.window.document;
const list = doc.getElementById('changed-files-list');
assert.ok(list, 'the shell has the Files list');
const panel = doc.getElementById('agentic-panel-files');
panel.classList.add('active');
panel.getClientRects = () => [{ width: 1, height: 1 }];

const files = [{ filepath: 'b.txt', status: 'modified', additions: 1, deletions: 0 }];
let releaseA;
const gateA = new Promise(r => { releaseA = r; });
const reply = (status, body) => ({ ok: status < 400, status, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body), clone() { return reply(status, body); } });
globalThis.fetch = dom.window.fetch = async (url, opts) => {
    const u = String(url);
    if (/\/api\/sessions\/live\/alpha\/files\/refresh/.test(u)) { await gateA; return reply(403, { error: 'access_mode' }); } // A's refusal, held until B is open
    if (/\/api\/sessions\/live\/beta\/files/.test(u)) return reply(200, { files, is_git: true, compare: { label: 'HEAD' } });
    return reply(200, { files: [], is_git: true });
};
const open = (name, sid) => { state.currentSession = { type: 'live', name, session_id: sid, agent_type: 'claude' }; };

open('alpha', 'sid-alpha');
const inflight = cf.refreshChangedFiles(); // A's refresh is on its way
open('beta', 'sid-beta'); // the person opens B
await cf.loadChangedFiles('beta', 'sid-beta');
assert.ok(/b\.txt/.test(list.innerHTML), 'B\'s list is drawn');
assert.ok(!/files-stale-note/.test(list.innerHTML), 'no note before the refusal');
releaseA(); // A's 403 arrives now
await inflight;
assert.ok(/b\.txt/.test(list.innerHTML), 'B\'s list is still drawn');
assert.ok(!/files-stale-note/.test(list.innerHTML), 'A\'s refusal drew nothing on B: no View-mode note');
// and B is not blocked: its own refresh is asked (no block was set for it)
let asked = false;
const f0 = globalThis.fetch;
globalThis.fetch = dom.window.fetch = async (url, opts) => { if (/\/api\/sessions\/live\/beta\/files\/refresh/.test(String(url))) { asked = true; return reply(200, { files, is_git: true, compare: { label: 'HEAD' } }); } return f0(url, opts); };
await cf.refreshChangedFiles();
assert.ok(asked, 'B\'s refresh is asked: A\'s refusal set no block on B');
console.log('Files refresh 403 for another agent checks passed');
process.exit(0);
