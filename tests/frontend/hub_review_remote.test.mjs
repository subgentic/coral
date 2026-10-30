// #11372: a self-hosted hub reaches a remote machine with its API key, and the machine refuses Approve, Request changes and the change-request send from a key (a script, not a person).
// The dashboard through coral --hub draws none of them for a remote, and still draws them for the hub's own machine. Through Coral Hub (isCloud) the owner's stamp carries the person: drawn.
// Run: node hub_review_remote.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'local' });
const server = await importUi('server_base');
assert.equal(server.isCloud(), false, 'the page is a self-hosted hub dashboard, not the Hub-served one');
assert.equal(server.decisionNeedsPerson('srv1'), true, 'a remote of the hub: no person reaches it, only the hub key');
assert.equal(server.decisionNeedsPerson('local'), false, "the hub's own machine: the person is at the dashboard");
assert.equal(server.decisionNeedsPerson(undefined), false);

globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'https://hub.example/');
    if (u.pathname.endsWith('/artifacts')) {
        const hex = 'a'.repeat(64);
        return Response.json({ artifacts: u.searchParams.get('tag') === 'for review' ? [{ id: hex, uri: `coral://artifacts/${hex}`, name: 'Plan', tags: ['for review'], available: true }] : [], has_more: false });
    }
    return Response.json({}, { status: 404 });
};

const { attachReview } = await importUi('artifact_review');
const doc = dom.window.document;
const d = doc.createElement('div');
d.innerHTML = '<div class="artifact-viewer-header"></div>';
doc.body.append(d);
const review = attachReview(d, { reload() {} });
const bar = d.querySelector('.artifact-review');
const hex = 'a'.repeat(64);

await review.open(hex, { server: 'srv1', board: 'team' });
assert.equal(bar.hidden, false, 'the state is still said');
assert.equal(bar.querySelector('.artifact-review-approve').hidden, true, 'no Approve for a remote');
assert.equal(bar.querySelector('.artifact-review-changes').hidden, true, 'no Request changes for a remote');
assert.match(bar.querySelector('.artifact-review-state').textContent, /own dashboard/, 'and it says where to decide');

await review.open(hex, { server: 'local', board: 'team' });
assert.equal(bar.querySelector('.artifact-review-approve').hidden, false, "the hub's own machine keeps Approve");
assert.equal(bar.querySelector('.artifact-review-changes').hidden, false);
assert.equal(bar.querySelector('.artifact-review-state').textContent, 'Waiting for your review');
console.log('hub_review_remote: ok');
