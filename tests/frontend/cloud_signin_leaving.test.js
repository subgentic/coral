// A page the browser has started to leave must not send itself to sign-in, whichever answer says it is signed out (#12970's guard on the fetch wrapper's 401; coral-hub Security's follow-up #13102: initCloud's
// authenticated:false and the live feed's signed-out hook sent location.replace(signInUrl()) with no guard, and a late answer on a leaving page replaced the navigation in flight). One helper, goToSignIn, now does it
// for all three; a page that is staying still goes to sign-in as before. Pure node with a stand-in window:  node cloud_signin_leaving.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
    const dir = path.resolve(__dirname, '../../coral-go/pkg/frontend/static');
    const listeners = {};
    const replaced = [];
    globalThis.window = globalThis;
    globalThis.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
    const fire = t => (listeners[t] || []).forEach(fn => fn({}));
    globalThis.location = { protocol: 'https:', host: 'hub.example', origin: 'https://hub.example', pathname: '/agents/@srv/abc123', search: '', hash: '', href: 'https://hub.example/agents/@srv/abc123', replace: u => replaced.push(u) };
    const boot = { textContent: JSON.stringify({ mode: 'cloud' }) };
    const body = { classList: { add() {}, contains() { return false; } }, dataset: {}, append() {}, appendChild() {}, getAttribute() { return null; }, setAttribute() {}, style: {} };
    globalThis.MutationObserver = class { observe() {} disconnect() {} }; globalThis.ResizeObserver = globalThis.MutationObserver; globalThis.IntersectionObserver = globalThis.MutationObserver; // what websocket.js touches when it is imported
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
    globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
    globalThis.document = { addEventListener() {}, getElementById: id => (id === 'coral-boot' ? boot : null), querySelector() { return null; }, body, createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, append() {}, addEventListener() {}, dataset: {} }), createTextNode: t => ({ nodeType: 3, t }) };
    globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    let sessionAnswer = null;
    globalThis.fetch = () => sessionAnswer; // /auth/session: the test decides when and what
    const cloud = await import(pathToFileURL(path.join(dir, 'cloud.js')).href);
    assert.equal(typeof cloud.goToSignIn, 'function', 'one helper sends a page to sign-in unless it is leaving');

    // the helper: a page that stays still goes; one that was told it is being left does not; a back-forward restore (pageshow) goes again
    cloud.installCloudFetch(); // registers the leave listeners once
    assert.equal(cloud.goToSignIn(), true); assert.deepEqual(replaced, ['/signin?next=' + encodeURIComponent('/agents/@srv/abc123')], 'a still page goes to sign-in');
    replaced.length = 0; fire('beforeunload');
    assert.equal(cloud.goToSignIn(), false); assert.deepEqual(replaced, [], 'a leaving page does not');
    fire('pageshow');
    assert.equal(cloud.goToSignIn(), true); assert.equal(replaced.length, 1, 'shown again, it does');
    replaced.length = 0; fire('pagehide'); assert.equal(cloud.goToSignIn(), false, 'pagehide marks the leave too');
    fire('pageshow'); replaced.length = 0;

    // initCloud: the session answer arrives (authenticated:false) after the leave began: no replace; on a still page: the replace
    const slow = answer => { let release; const p = new Promise(r => { release = () => r({ ok: true, json: () => Promise.resolve(answer) }); }); return { p, release }; };
    let s = slow({ authenticated: false });
    sessionAnswer = s.p; cloud.loadSession(true); // a fresh read
    const leaving = cloud.initCloud();
    fire('beforeunload');
    s.release();
    assert.equal(await leaving, false, 'initCloud says it is not going on');
    assert.deepEqual(replaced, [], 'a late signed-out answer on a leaving page makes no replace');
    fire('pageshow');
    s = slow({ authenticated: false });
    sessionAnswer = s.p; cloud.loadSession(true);
    const still = cloud.initCloud();
    s.release();
    assert.equal(await still, false);
    assert.equal(replaced.length, 1, 'the same answer on a page that stays still goes to sign-in');

    // the live feed's signed-out hook, called as the feed calls it once the browser is confirmed signed out (QA Reviewer 2: the hook itself, not a regex over its source)
    const feed = await import(pathToFileURL(path.join(dir, 'websocket.js')).href);
    replaced.length = 0; fire('pageshow');
    feed.feedHooks.signedOut();
    assert.equal(replaced.length, 1, 'a still page: the feed hook sends it to sign-in');
    replaced.length = 0; fire('beforeunload');
    feed.feedHooks.signedOut();
    assert.deepEqual(replaced, [], 'a leaving page: the feed hook sends nothing');
    fire('pageshow'); location.pathname = '/signin';
    feed.feedHooks.signedOut();
    assert.deepEqual(replaced, [], 'on the sign-in page itself it still does nothing');
    location.pathname = '/agents/@srv/abc123';

    // and the one place that replaces to sign-in in cloud.js is the helper (the fetch wrapper's 401 is the browser suite's, hub_signin_late_401_browser)
    const cl = fs.readFileSync(path.join(dir, 'cloud.js'), 'utf8');
    assert.equal((cl.match(/location\.replace\(signInUrl\(\)\)/g) || []).length, 1, 'cloud.js replaces to sign-in in one place, the helper');
    console.log('cloud_signin_leaving: ok');
})().catch(e => { console.error(e); process.exit(1); });
