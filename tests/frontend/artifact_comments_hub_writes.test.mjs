// #14549 (coral-hub #190933): a Hub owner could not comment on a document in review. The shell forced canComment, canLock and every per-comment can to false for any Coral Hub page, whatever the computer said,
// and never read the account's comment_writes. Now: when the account says comment_writes true, the computer's own answer (you.can_comment, you.can_lock, each comment's can) is used as it is; when it does not
// say so (absent, false, malformed), the drawer stays read only with its old words. Also the two small words of the same change: a lock that covers a whole board says so, and a comment over the agent's cap says
// only the first 700 characters are sent.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const scenario = process.argv[2];
const ANSWER = { comments: [{ id: 1, body: 'x', author: { name: 'You' }, can: { reply: true, edit: true, delete: true, resolve: true } }], locked: false,
    you: { kind: 'owner', can_comment: true, can_lock: true, reason: '' }, limits: {} };
if (!scenario) {
    const { spawnSync } = await import('./helpers/child_process.js');
    const { fileURLToPath } = await import('node:url');
    let failures = 0;
    for (const name of ['writes-on', 'writes-and-send', 'writes-off', 'writes-absent', 'writes-malformed']) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8' });
        if (r.status) { failures++; console.error(name + '\n' + r.stdout + r.stderr); } else console.log('PASS comment writes ' + name);
    }
    assert.equal(failures, 0, 'comment write cases failed');
    // the words (no account needed)
    installDom({ mode: 'local' });
    const api = await importUi('artifact_comments_api');
    assert.equal(api.lockedWords({ locked: true, canLock: true, lockScope: 'board', lockBoard: 'team-a' }, 'file'), 'Comments are locked on every file of team-a: read only. It is a board-wide lock, so it is changed on the computer itself, not from one file.');
    assert.equal(api.lockedWords({ locked: true, canLock: false, lockScope: 'board', lockBoard: 'team-a' }, 'file'), 'Comments are locked on every file of team-a: read only. It is a board-wide lock, so it is changed on the computer itself, not from one file.');
    assert.equal(api.lockedWords({ locked: true, canLock: true, lockScope: 'artifact' }, 'file'), 'Comments are locked: nobody can add comments to this file. You can unlock it any time.');
    assert.equal(api.lockedWords({ locked: true, canLock: false }, 'file'), 'Comments are locked: read only.');
    assert.doesNotMatch(api.lockedWords({ locked: true, canLock: true, lockScope: 'board', lockBoard: 'team-a' }, 'file'), /unlock it any time/, 'the board-lock words never offer an unlock the button cannot do');
    const send = await importUi('artifact_comment_send');
    assert.equal(send.SEND_COMMENT_CAP, 700);
    const mk = long => send.buildSendBlock({ id: 1, board: 'team-a', agents: [], picked: new Set(), asked: new Map(), count: 1, long, results: null, busy: false, error: '', onToggle() {}, onCancel() {}, onSend() {} });
    assert.match(mk(true).textContent, /Only the first 700 characters are sent to the agent\./);
    assert.doesNotMatch(mk(false).textContent, /Only the first 700/);
    console.log('artifact_comments_hub_writes: the lock words and the 700-character note');
} else {
    const accounts = { 'writes-on': { comment_writes: true }, 'writes-and-send': { comment_writes: true, comment_send: true }, 'writes-off': { comment_writes: false }, 'writes-absent': {}, 'writes-malformed': { comment_writes: 'true' } };
    installDom({ mode: 'cloud', boot: {} });
    globalThis.fetch = window.fetch = async url => {
        const u = String(url);
        if (u === '/api/account') return { ok: true, json: async () => accounts[scenario] };
        return { ok: true, status: 200, json: async () => ANSWER, text: async () => JSON.stringify(ANSWER), headers: { get: () => 'application/json' } };
    };
    const base = await importUi('server_base');
    await base.initCloudAccountFlags();
    const api = await importUi('artifact_comments_api');
    const d = await api.listComments('a'.repeat(64), '', '');
    if (scenario === 'writes-on' || scenario === 'writes-and-send') {
        assert.equal(base.commentWritesOn(), true);
        assert.equal(d.canComment, true, 'the computer said the owner may comment');
        assert.equal(base.commentSendOn(), scenario === 'writes-and-send');
        assert.equal(d.canLock, scenario === 'writes-and-send', 'the lock (and with it Send to agent) is drawn only when the account says comment_send');
        assert.deepEqual(d.comments[0].can, { reply: true, edit: true, delete: true, resolve: true }, "each comment's can is the computer's");
    } else {
        assert.equal(base.commentWritesOn(), false);
        assert.equal(d.canComment, false, 'the Hub does not say it routes writes: read only, as before');
        assert.equal(d.canLock, false);
        assert.match(d.reason, /Comments can be added on the computer itself/);
        assert.deepEqual(d.comments[0].can, { reply: false, edit: false, delete: false, resolve: false });
    }
}
