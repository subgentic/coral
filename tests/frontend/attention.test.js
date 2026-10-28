// Unit test for what the page does when an agent needs the person or finishes a reply while the tab is in the background (#10068, desktop pass #10063):
// a count in the tab title, the desktop alert per kind with an optional sound, nothing while the tab is visible.
//   node attention.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

(async () => {
    const dir = path.resolve(__dirname, '../../coral-go/pkg/frontend/static');
    const dom = new JSDOM('<!doctype html><title>Coral</title><body></body>', { url: 'https://hub.example/' });
    for (const k of ['window', 'document', 'localStorage']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    const shown = [];
    let perm = 'granted', hidden = true;
    class FakeNotification {
        constructor(title, opts) { this.title = title; this.opts = opts; shown.push(this); }
        close() {}
        static get permission() { return perm; }
        static async requestPermission() { return perm; }
    }
    Object.defineProperty(globalThis, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden, configurable: true });
    const a = await import(pathToFileURL(path.join(dir, 'attention.js')).href);
    const n = await import(pathToFileURL(path.join(dir, 'desktop_notify.js')).href);

    // the tab title: a count while hidden, gone on return
    assert.strictEqual(document.title, 'Coral');
    assert.strictEqual(a.noteAttention(a.KIND_REPLY, { agent: 'Ada', tag: 'a' }), true);
    assert.strictEqual(document.title, '(1) Coral');
    assert.strictEqual(a.noteAttention(a.KIND_NEEDS_INPUT, { agent: 'Bo', tag: 'b' }), true);
    assert.strictEqual(document.title, '(2) Coral', 'the number grows, the prefix does not stack');
    assert.ok(!/Ada|Bo/.test(document.title), 'a number, never a name');
    hidden = false;
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.strictEqual(document.title, 'Coral', 'cleared when the person comes back');

    // a visible tab: nothing counted, nothing shown
    assert.strictEqual(a.noteAttention(a.KIND_REPLY, { agent: 'Ada', tag: 'c' }), false);
    assert.strictEqual(document.title, 'Coral');
    hidden = true;

    // another page's own title is kept under the count, and a count over 99 is "99+"
    document.title = 'Team · Coral';
    a.noteAttention(a.KIND_REPLY, { agent: 'x', tag: 'x1' });
    assert.strictEqual(document.title, '(1) Team · Coral');
    for (let i = 0; i < 120; i++) a.noteAttention(a.KIND_REPLY, { agent: 'x', tag: 'many' + i });
    assert.strictEqual(document.title, '(99+) Team · Coral');
    a.clearAttention();
    assert.strictEqual(document.title, 'Team · Coral');
    document.title = 'Coral';

    // the desktop alert is per kind and says what happened
    dom.window.localStorage.setItem(n.DESKTOP_NOTIFY_KEY, '1');
    n._resetRateForTests(); shown.length = 0;
    assert.deepStrictEqual(n.alertPrefs(), { needsInput: true, finished: true, sound: false }, 'defaults: both kinds, no sound');
    a.noteAttention(a.KIND_REPLY, { agent: 'Ada', where: 'laptop', tag: 'r1' });
    a.noteAttention(a.KIND_NEEDS_INPUT, { agent: 'Ada', where: 'laptop', tag: 'r1' });
    assert.strictEqual(shown.length, 2, 'the same agent: one alert of each kind');
    assert.strictEqual(shown[0].opts.body, 'Ada finished a reply on laptop');
    assert.strictEqual(shown[1].opts.body, 'Ada needs input on laptop');
    assert.strictEqual(shown[0].opts.tag, 'finished:r1');
    assert.strictEqual(shown[0].opts.silent, true);
    assert.deepStrictEqual(Object.keys(shown[0].opts).sort(), ['body', 'silent', 'tag'], 'names only: no icon, data or image');
    a.clearAttention();

    // each kind can be turned off on its own, and the title count still counts
    n._resetRateForTests(); shown.length = 0;
    n.setAlertPref('finished', false);
    a.noteAttention(a.KIND_REPLY, { agent: 'B', tag: 'k1' });
    assert.strictEqual(shown.length, 0, 'finished-reply alerts off');
    assert.strictEqual(document.title, '(1) Coral', 'the count is not an alert');
    a.noteAttention(a.KIND_NEEDS_INPUT, { agent: 'B', tag: 'k2' });
    assert.strictEqual(shown.length, 1);
    n.setAlertPref('needsInput', false);
    a.noteAttention(a.KIND_NEEDS_INPUT, { agent: 'C', tag: 'k3' });
    assert.strictEqual(shown.length, 1, 'needs input off');
    a.clearAttention();

    // the sound is the system's own, and only when turned on
    n.setAlertPref('needsInput', true); n.setAlertPref('sound', true); n._resetRateForTests(); shown.length = 0;
    a.noteAttention(a.KIND_NEEDS_INPUT, { agent: 'D', tag: 's1' });
    assert.strictEqual(shown[0].opts.silent, false);
    a.clearAttention();

    // a blocked browser: the title still counts, no alert, and the setting can say why
    perm = 'denied'; shown.length = 0; n._resetRateForTests();
    assert.strictEqual(n.desktopNotifyBlocked(), true);
    a.noteAttention(a.KIND_REPLY, { agent: 'E', tag: 'd1' });
    assert.strictEqual(shown.length, 0);
    assert.strictEqual(document.title, '(1) Coral');
    perm = 'granted';
    assert.strictEqual(n.desktopNotifyBlocked(), false);
    console.log('attention: ok');
})().catch(e => { console.error(e); process.exit(1); });
