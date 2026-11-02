// The Hub's sign-in comes back to the address the person opened (#12432, coral-hub's named deep-link test: a signed-out visit to /agents/@<server>/<session>/files came back without /files about one run in three). The app
// shortens an address it cannot show yet before a late session check sends the page to /signin; the next= is the address the page was opened at when it is BELOW the one on screen, else the one on screen. jsdom, no browser.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const dom = installDom({ mode: 'cloud' });
const { signInUrl } = await importUi('cloud');
const { setServedAddress } = await importUi('served_address');
const at = url => { dom.reconfigure({ url: 'https://hub.example' + url }); };

at('/agents/@srv/abc123/files');
setServedAddress('/agents/@srv/abc123/files');
at('/agents/@srv/abc123'); // the app shortened it
assert.equal(signInUrl(), '/signin?next=' + encodeURIComponent('/agents/@srv/abc123/files'), 'the Hub path comes back whole, with its tab');
at('/agents/@srv/abc123/files');
assert.equal(signInUrl(), '/signin?next=' + encodeURIComponent('/agents/@srv/abc123/files'), 'unshortened: the address on screen');
setServedAddress('');
at('/agents/@srv/abc123');
assert.equal(signInUrl(), '/signin?next=' + encodeURIComponent('/agents/@srv/abc123'), 'once the person has moved on: the page they are on');
setServedAddress('/agents/@srv/abc123/files?x=1#frag');
at('/agents/@srv/abc123');
assert.equal(signInUrl(), '/signin?next=' + encodeURIComponent('/agents/@srv/abc123/files?x=1'), 'its query as opened, and never a fragment (the Hub\'s next= must not carry one)');
assert.ok(!decodeURIComponent(signInUrl()).includes('#'), 'no # in next=');
setServedAddress('//evil.example/agents/x');
at('/');
assert.equal(signInUrl(), '/signin', 'a protocol-relative address is never used; the bare start sends no next');
setServedAddress('/inbox/goals');
at('/agents');
assert.equal(signInUrl(), '/signin?next=' + encodeURIComponent('/agents'), 'an unrelated served address is not used');
setServedAddress('');
at('/');
assert.equal(signInUrl(), '/signin', 'the bare start has no next');
console.log('cloud_signin_return: ok');
