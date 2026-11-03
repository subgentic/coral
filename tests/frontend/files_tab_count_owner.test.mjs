// The Files tab's number has one owner at a time (#12699, QA's two SHOULDs on #12683): while the Files panel shows, the list on screen owns the number and the session feed's count is not drawn.
//   1. switching to another agent while the panel shows: the owner is the OLD agent's list until the new list draws, so the new agent's feed moves the number (nothing stale is held back), and once the
//      new list has drawn, it owns the number and its feed is ignored;
//   2. the non-git path draws its empty badge through the owner: a folder with nothing to list owns an empty number, and a feed count does not put one on it.
//   node files_tab_count_owner.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'cloud' });
const { state } = await importUi('state');
const cf = await importUi('changed_files');
const doc = dom.window.document;
const badge = () => doc.getElementById('files-bar-count');
const panel = doc.getElementById('agentic-panel-files');
assert.ok(badge() && panel && doc.getElementById('changed-files-list'), 'the shell has the Files panel');
panel.classList.add('active');
panel.getClientRects = () => [{ width: 1, height: 1 }]; // jsdom has no layout: the panel "shows"
const showing = on => { panel.classList.toggle('active', on); };

let answers = {};
globalThis.fetch = dom.window.fetch = async url => {
    const m = /\/api\/sessions\/live\/([^/]+)\/files(\/refresh)?(\?|$)/.exec(String(url));
    const body = (m && answers[m[1]]) || { files: [], is_git: true };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map(), url: String(url) };
};
const files = n => Array.from({ length: n }, (_, i) => ({ filepath: `f${i}.txt`, status: 'modified', additions: 1, deletions: 0 }));
const open = (name, sid) => { state.currentSession = { type: 'live', name, session_id: sid, agent_type: 'claude' }; };
const draw = async (name, sid) => { open(name, sid); await cf.loadChangedFiles(name, sid); };

// ── 1. switching agent while the panel shows ──
answers.alpha = { files: files(3), is_git: true, compare: { label: 'HEAD' } };
answers.beta = { files: files(2), is_git: true, compare: { label: 'HEAD' } };
await draw('alpha', 'sid-alpha');
assert.equal(badge().textContent, '3', 'alpha\'s list draws its number');
cf.updateChangedFileCount(5);
assert.equal(badge().textContent, '3', 'alpha\'s list owns it: the feed\'s 5 is not drawn');
open('beta', 'sid-beta'); // the person switches to beta; its list has not drawn yet
cf.updateChangedFileCount(7);
assert.equal(badge().textContent, '7', 'beta has no list yet: its feed moves the number, alpha\'s ownership is not carried over');
await cf.loadChangedFiles('beta', 'sid-beta');
assert.equal(badge().textContent, '2', 'beta\'s list draws its own number');
cf.updateChangedFileCount(9);
assert.equal(badge().textContent, '2', 'and now beta\'s list owns it');
open('alpha', 'sid-alpha'); // back to alpha before its list redraws: beta's ownership does not hold alpha's number either
cf.updateChangedFileCount(4);
assert.equal(badge().textContent, '4', 'back on alpha with no redraw yet: the feed moves it, beta\'s ownership is not alpha\'s');

// the stale case: alpha's list owned the number, the person looked at beta (its feed wrote 7), and is back on alpha before alpha's list redraws: the owner must not still be alpha, or 7 stays on alpha's tab
await draw('alpha', 'sid-alpha');
open('beta', 'sid-beta');
cf.updateChangedFileCount(7);
open('alpha', 'sid-alpha');
cf.updateChangedFileCount(3);
assert.equal(badge().textContent, '3', 'a number written by another agent\'s feed is not left on alpha by an old claim of ownership');

// ── 2. the non-git path draws its empty badge through the owner ──
answers.plain = { files: [], is_git: false };
showing(true);
cf.updateChangedFileCount(6);
await draw('plain', 'sid-plain');
assert.equal(badge().textContent, '', 'a folder that is not git, with nothing to list: the badge is empty');
cf.updateChangedFileCount(6);
assert.equal(badge().textContent, '', 'the list owns the empty number: a feed count does not put one on it');
showing(false);
cf.updateChangedFileCount(6);
assert.equal(badge().textContent, '6', 'with the panel not showing the feed moves it, as before');
console.log('Files tab count owner checks passed');
process.exit(0);
