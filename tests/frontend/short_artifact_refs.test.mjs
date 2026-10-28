// short_artifact_refs.js (#9841): a shortened coral://artifacts link in an older message becomes a link once the server names the one artifact it means; one that matches none stays text;
// code and existing links are left alone; the answers are remembered, so a message drawn again asks nothing.
//   node short_artifact_refs.test.mjs
import assert from 'node:assert';

process.env.CORAL_TELEMETRY_DISABLED = '1'; // this test starts no Coral (a jsdom page and a faked fetch); the opt-out stays on, as the telemetry census wants it in every suite that names one
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const refs = await importUi('short_artifact_refs');
const A = 'b801aafb' + '0'.repeat(53) + 'f5f';
assert.equal(A.length, 64);

// the scanner
assert.deepEqual(refs.findShortRefs('see coral://artifacts/b801aafb…f5f now').map(f => f.ref), ['b801aafb…f5f']);
assert.deepEqual(refs.findShortRefs('coral://artifacts/b801aafb...f5f.').map(f => f.ref), ['b801aafb…f5f'], 'three dots read as the ellipsis');
assert.deepEqual(refs.findShortRefs('coral://artifacts/b801aafb').map(f => f.ref), ['b801aafb']);
assert.deepEqual(refs.findShortRefs('coral://artifacts/' + A), [], 'a full link is not a short one');
assert.deepEqual(refs.findShortRefs('coral://artifacts/b801aaf'), [], 'seven digits are no ref');
assert.deepEqual(refs.findShortRefs('hex b801aafb and 5c0de1a2 alone'), [], 'bare hex is not a ref');
assert.deepEqual(refs.findShortRefs('shot b801aafb and artifact 5c0de1a2').map(f => [f.ref, f.worded]), [['b801aafb', true], ['5c0de1a2', true]], 'but after the word shot or artifact it is a worded one');
assert.deepEqual(refs.findShortRefs('screenshot b801aafb'), [], 'the word stands alone');
assert.deepEqual(refs.findShortRefs('xcoral://artifacts/b801aafb'.replace('xcoral', 'x/coral')), [], 'not after a path character');

// the page
const asked = [];
globalThis.fetch = async (url) => {
    asked.push(String(url));
    const links = new URL(String(url), 'http://localhost').searchParams.getAll('link');
    return { ok: true, json: async () => ({ refs: links.map(l => ({ ref: l, id: ['b801aafb…f5f', 'b801aafb'].includes(l) ? A : null, matches: ['b801aafb…f5f', 'b801aafb'].includes(l) ? 1 : 0 })) }) };
};
const root = document.createElement('div');
root.innerHTML = '<div class="mb-message"><div class="mb-message-body">'
    + '<p id="a">report coral://artifacts/b801aafb…f5f is ready</p>'
    + '<p id="b">unknown coral://artifacts/0123abcd…fff stays</p>'
    + '<p id="c"><code>coral://artifacts/b801aafb…f5f</code></p>'
    + '<p id="d"><a href="https://example.com">coral://artifacts/b801aafb…f5f</a></p>'
    + '<p id="e">see shot b801aafb and artifact 5c0de1a2 too</p>'
    + '</div></div>';
document.body.append(root);
let bound = 0;
const changed = await refs.upgradeShortArtifactRefs(root, undefined, () => { bound++; });
assert.equal(changed, true);
assert.equal(bound, 1, 'the artifact pass that binds the new links ran once');
const link = root.querySelector('#a a.mb-artifact-ref');
assert.ok(link, 'the resolved ref is a link');
assert.equal(link.getAttribute('href'), `coral://artifacts/${A}`);
assert.equal(link.textContent, 'artifact b801aafb');
assert.equal(root.querySelector('#a').textContent, 'report artifact b801aafb is ready');
const worded = root.querySelector('#e a');
assert.ok(worded, 'a worded id that resolves is a link');
assert.equal(worded.textContent, 'b801aafb', 'with the digits it was written with');
assert.equal(worded.getAttribute('href'), `coral://artifacts/${A}`);
assert.equal(worded.getAttribute('aria-label'), 'Open artifact b801aafb', 'a screen reader hears what the link opens, with the digits that are shown');
assert.equal(root.querySelector('#a a.mb-artifact-ref').getAttribute('aria-label'), null, 'a full-form link keeps its visible name')
assert.equal(root.querySelector('#e').textContent, 'see shot b801aafb and artifact 5c0de1a2 too', 'the sentence reads as written');
assert.equal(root.querySelectorAll('#e a').length, 1, 'the one that matches none stays text');
assert.equal(root.querySelector('#b').textContent, 'unknown coral://artifacts/0123abcd…fff stays', 'one that matches none stays the text it was');
assert.ok(!root.querySelector('#b a'));
assert.equal(root.querySelector('#c code').textContent, 'coral://artifacts/b801aafb…f5f', 'code is left alone');
assert.equal(root.querySelector('#d a').textContent, 'coral://artifacts/b801aafb…f5f', 'an existing link is left alone');
assert.equal(asked.length, 1);
assert.deepEqual(new URL(asked[0], 'http://localhost').searchParams.getAll('link').sort(), ['0123abcd…fff', '5c0de1a2', 'b801aafb', 'b801aafb…f5f'], 'one ask for the distinct refs of the page');

// drawn again: remembered, nothing asked
const again = document.createElement('div');
again.innerHTML = '<div class="mb-message-body"><p>again coral://artifacts/b801aafb…f5f and coral://artifacts/0123abcd…fff</p></div>';
document.body.append(again);
assert.equal(await refs.upgradeShortArtifactRefs(again, undefined, () => {}), true);
assert.equal(asked.length, 1, 'the answers are kept');

// another Coral's messages are not asked
const other = document.createElement('div');
other.innerHTML = '<div class="mb-message-body"><p>coral://artifacts/b801aafb…f5f</p></div>';
assert.equal(await refs.upgradeShortArtifactRefs(other, 'remote-1', () => {}), false);
assert.equal(asked.length, 1);

// a server that does not answer leaves the text, and the next draw asks again
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
const lost = document.createElement('div');
lost.innerHTML = '<div class="mb-message-body"><p>coral://artifacts/9999aaaa…bbb</p></div>';
assert.equal(await refs.upgradeShortArtifactRefs(lost, undefined, () => {}), false);
assert.equal(lost.textContent, 'coral://artifacts/9999aaaa…bbb');
console.log('short_artifact_refs: ok');
