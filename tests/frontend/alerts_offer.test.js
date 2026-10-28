// Unit test for the one-time offer of desktop alerts after the first agent starts (#10068, desktop pass #10063):
//   node alerts_offer.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

(async () => {
    const dir = path.resolve(__dirname, '../../coral-go/pkg/frontend/static');
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://hub.example/' });
    for (const k of ['window', 'document', 'localStorage']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    for (const k of ['MutationObserver', 'HTMLElement', 'Node', 'getComputedStyle']) if (dom.window[k]) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    let perm = 'default', asked = 0, answer = 'granted';
    class FakeNotification {
        static get permission() { return perm; }
        static async requestPermission() { asked++; perm = answer; return perm; }
    }
    Object.defineProperty(globalThis, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    const m = await import(pathToFileURL(path.join(dir, 'alerts_offer.js')).href);
    const toasts = () => [...document.querySelectorAll('.toast')].map(t => t.querySelector('.toast-message').textContent);

    // first agent, nothing asked yet: one toast, with one button, and no permission box (a browser ignores one that is not from a click)
    assert.strictEqual(m.offerAlertsAfterLaunch(), true);
    assert.strictEqual(toasts().length, 1);
    assert.match(toasts()[0], /alert when an agent needs you or finishes a reply/);
    assert.strictEqual(asked, 0, 'the box is not shown by the offer itself');
    assert.strictEqual(dom.window.localStorage.getItem(m.ALERTS_OFFERED_KEY), '1', 'offered once per browser');

    // the second agent: nothing more, whatever the person did with the first toast
    assert.strictEqual(m.offerAlertsAfterLaunch(), false);
    assert.strictEqual(toasts().length, 1);

    // the button is the click that asks: allowed turns alerts on and says where to change it
    document.querySelector('.toast-action').click();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(asked, 1);
    assert.strictEqual(dom.window.localStorage.getItem('coral-desktop-notify'), '1');
    assert.ok(toasts().some(t => /Alerts are on\. Change them in Settings > Notifications\./.test(t)), JSON.stringify(toasts()));

    // refused: says alerts stay off and where to try again
    dom.window.localStorage.clear(); perm = 'default'; answer = 'denied'; asked = 0;
    document.querySelectorAll('.toast').forEach(t => t.remove());
    m.offerAlertsAfterLaunch();
    document.querySelector('.toast-action').click();
    await new Promise(r => setTimeout(r, 20));
    assert.ok(toasts().some(t => /Alerts stay off: your browser did not allow them/.test(t)), JSON.stringify(toasts()));
    assert.strictEqual(dom.window.localStorage.getItem('coral-desktop-notify'), null);

    // nothing to offer: a browser that blocks alerts, has none, or already has them on
    for (const [label, setup] of [
        ['blocked', () => { perm = 'denied'; }],
        ['granted but not opted in', () => { perm = 'granted'; }],
    ]) {
        dom.window.localStorage.clear(); perm = 'default'; document.querySelectorAll('.toast').forEach(t => t.remove());
        setup();
        assert.strictEqual(m.offerAlertsAfterLaunch(), false, label);
        assert.strictEqual(toasts().length, 0, label);
    }
    dom.window.localStorage.clear(); perm = 'granted'; dom.window.localStorage.setItem('coral-desktop-notify', '1');
    assert.strictEqual(m.offerAlertsAfterLaunch(), false, 'already on');
    delete globalThis.Notification; Object.defineProperty(globalThis, 'Notification', { value: undefined, configurable: true, writable: true });
    dom.window.localStorage.clear();
    assert.strictEqual(m.offerAlertsAfterLaunch(), false, 'a browser with no desktop alerts');

    // the wiring: the launch dialog and the team launch offer it after a launch that started something
    const ld = fs.readFileSync(path.join(dir, 'launch_dialog.js'), 'utf8');
    const td = fs.readFileSync(path.join(dir, 'team_dialogs.js'), 'utf8');
    assert.ok(/hideLaunchModal\(\);\s*importOnce\('\.\/alerts_offer\.js'\)\.then\(m => m\.offerAlertsAfterLaunch\(\)\)/.test(ld), 'launch_dialog.js offers after a launch');
    assert.ok(/importOnce\('\.\/alerts_offer\.js'\)\.then\(m => m\.offerAlertsAfterLaunch\(\)\)[^\n]*\n\s*setTimeout\(loadLiveSessions/.test(td), 'team_dialogs.js offers after a team started');
    // the offer never reads or sends anything about the agent
    const src = fs.readFileSync(path.join(dir, 'alerts_offer.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/fetch\(|sendBeacon|session|agent\.name|display_name/.test(src.replace(/an agent needs you|an agent|every agent/g, '')), 'no agent data');
    console.log('alerts_offer: ok');
})().catch(e => { console.error(e); process.exit(1); });
