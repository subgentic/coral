import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
state.selectedTeam = '@m2/dev'; // current context must not redirect a separately mounted goal
const { registerBundled } = await importUi('import_once');
let opened;
registerBundled({ 'artifact_comments.js': { attachComments: () => ({ open: (...args) => { opened = args; }, docWhole() {}, close() {} }) } });
const { goalSubject, mountGoalComments } = await importUi('goal_comments');
const api = await importUi('artifact_comments_api');
const calls = [];
globalThis.fetch = window.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    return Response.json({ hex: 'a'.repeat(64), comments: [], you: { can_comment: true } });
};
test('a goal comment subject uses the bare board name', () => {
    assert.equal(goalSubject('@m1/dev', 5), 'goal:dev:5');
    assert.equal(goalSubject('dev', 5), 'goal:dev:5');
});
test('mount routes list and send with the goal team computer and bare board, independently of selected context', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const mounted = mountGoalComments(host, { team: '@m1/dev', goalId: 5 });
    assert.deepEqual(opened, ['goal:dev:5', 'm1', 'dev']);
    calls.length = 0;
    await api.listComments(...opened);
    await api.createComment(opened[0], opened[1], { body: 'reply', anchor: { whole: true }, board: opened[2] });
    assert.equal(calls[0].url, '/api/remote/m1/api/artifacts/goal:dev:5/comments?state=all&board=dev');
    assert.equal(calls[1].url, '/api/remote/m1/api/artifacts/goal:dev:5/comments');
    assert.equal(JSON.parse(calls[1].body).board, 'dev');
    mounted.destroy();
});
test('a remote goal comment image uses that computer goal-images route', async () => {
    calls.length = 0;
    await api.uploadCommentImage(goalSubject('@m1/dev', 5), 'm1', new Blob(['image'], { type: 'image/png' }), null, 'dev');
    assert.equal(calls[0].url, '/api/remote/m1/api/board/dev/goal-images');
});
