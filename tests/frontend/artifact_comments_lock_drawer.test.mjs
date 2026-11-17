// #14592 (UI SHOULD on #14549): the owner's comment drawer MOUNTED (attachComments, the real modules) in cloud mode, not a source pattern. Cases, each in a fresh process (the account's flags are module state):
// comment_writes and comment_send on and off, an artifact lock versus a board lock, an unlocked file, and the computer's own can answering false. Board lock: no Unlock button, the board-wide words; artifact lock: the
// button, and its click sends DELETE {scope:'artifact'}; no comment_send: no lock control at all; writes off or the computer saying no: no comment button and no per-comment actions.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const scenario = process.argv[2];
const CASES = {
    'send-artifact-lock': { acct: { comment_writes: true, comment_send: true }, ans: { locked: true, lock_scope: 'artifact' } },
    'send-board-lock': { acct: { comment_writes: true, comment_send: true }, ans: { locked: true, lock_scope: 'board', lock_board: 'team-a' } },
    'send-unlocked': { acct: { comment_writes: true, comment_send: true }, ans: { locked: false } },
    'nosend-unlocked': { acct: { comment_writes: true }, ans: { locked: false } },
    'nosend-board-lock': { acct: { comment_writes: true }, ans: { locked: true, lock_scope: 'board', lock_board: 'team-a' } },
    'writes-off': { acct: { comment_writes: false }, ans: { locked: false } },
    'machine-says-no': { acct: { comment_writes: true, comment_send: true }, ans: { locked: false, you: { kind: 'owner', can_comment: false, can_lock: false, reason: 'No.' }, can: { reply: false, edit: false, delete: false, resolve: false } } },
};
if (!scenario) {
    const { spawnSync } = await import('./helpers/child_process.js');
    const { fileURLToPath } = await import('node:url');
    let failures = 0;
    for (const name of Object.keys(CASES)) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8' });
        if (r.status) { failures++; console.error(name + '\n' + r.stdout + r.stderr); } else console.log('PASS comment lock drawer ' + name);
    }
    assert.equal(failures, 0, 'comment lock drawer cases failed');
} else {
    const c = CASES[scenario];
    installDom({ mode: 'cloud', boot: {} });
    window.Element.prototype.getClientRects = function () { return [{}]; };
    const HEX = 'e'.repeat(64);
    const can = c.ans.can || { reply: true, edit: true, delete: true, resolve: true };
    const answer = { comments: [{ id: 1, parent_id: null, anchor: { whole: true }, body: 'hello', author: { kind: 'owner', issuer: 'local', subject: 'Operator', name: 'You' }, created_at: new Date().toISOString(), state: 'open', can }],
        locked: c.ans.locked, lock_scope: c.ans.lock_scope, lock_board: c.ans.lock_board, you: c.ans.you || { kind: 'owner', can_comment: true, can_lock: true, reason: '' }, limits: {} };
    const sent = [];
    const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = window.fetch = async (url, init = {}) => {
        const u = String(url), m = (init.method || 'GET').toUpperCase();
        if (u === '/api/account') return json(c.acct);
        if (m !== 'GET') { sent.push({ m, u, body: init.body }); return json({}); }
        return json(answer);
    };
    const base = await importUi('server_base');
    await base.initCloudAccountFlags();
    const { attachComments } = await importUi('artifact_comments');
    const dialog = document.createElement('div'), body = document.createElement('div'), host = document.createElement('div');
    document.body.append(dialog, host);
    const drawer = attachComments(dialog, body, host, { toggleHost: true, sheet: () => false, shown: () => true, words: { empty: 'No comments.', whole: 'Comment', quote: 'This' } });
    drawer.open(HEX, undefined, 'team-a'); drawer.docWhole(); drawer.setSheet(true);
    const q = s => host.querySelector(s);
    for (const t0 = Date.now(); !q('.ac-card'); ) { if (Date.now() - t0 > 2000) assert.fail('the drawer drew no comment'); await new Promise(r => setTimeout(r, 10)); }
    const lock = q('.ac-lock'), note = q('.ac-locked')?.textContent || '';
    switch (scenario) {
        case 'send-artifact-lock':
            assert.ok(lock, 'an artifact lock the owner may undo draws the Unlock button');
            assert.equal(lock.getAttribute('aria-label'), 'Unlock comments');
            assert.match(note, /nobody can add comments to this file/);
            lock.click(); await new Promise(r => setTimeout(r, 30));
            assert.equal(sent.length, 1); assert.equal(sent[0].m, 'DELETE'); assert.deepEqual(JSON.parse(sent[0].body), { scope: 'artifact' });
            break;
        case 'send-board-lock':
        case 'nosend-board-lock':
            assert.equal(lock, null, 'a board-wide lock draws no artifact Unlock button');
            assert.match(note, /locked on every file of team-a: read only\. It is a board-wide lock, so it is changed on the computer itself/);
            assert.doesNotMatch(note, /unlock it any time|Press to unlock/);
            assert.equal(sent.length, 0);
            break;
        case 'send-unlocked':
            assert.ok(lock && lock.getAttribute('aria-label') === 'Lock comments', 'the owner may lock when the account says comment_send');
            assert.ok(q('.ac-whole'), 'the owner may comment when the account says comment_writes');
            assert.ok(q('.ac-act'), "each comment's actions are the computer's (true)");
            break;
        case 'nosend-unlocked':
            assert.equal(lock, null, 'no comment_send: no lock control');
            assert.ok(q('.ac-whole'), 'writes are on: the comment button is drawn');
            break;
        case 'writes-off':
            assert.equal(lock, null); assert.equal(q('.ac-whole'), null, 'writes off: read only, no comment button');
            assert.equal(host.querySelectorAll('.ac-act').length, 0, 'no per-comment actions');
            break;
        case 'machine-says-no':
            assert.equal(lock, null, 'the computer said can_lock false'); assert.equal(q('.ac-whole'), null, 'the computer said can_comment false');
            assert.equal(host.querySelectorAll('.ac-act').length, 0, "the computer's can said false for every action");
            break;
    }
    drawer.close();
}
