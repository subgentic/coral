// Pure-node test of the Coral Hub /enroll page (the hub renders our template and our enroll.js):
//   node enroll_page.test.js
// 1. The page says "Connect to Coral Hub" (title and heading) and the short intro.
// 2. ?code= still prefills the code field and looks it up; without it the field is focused.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.resolve(__dirname, '../../coral-go/pkg/frontend');

// ── 1. template text ─────────────────────────────────────────────────
const tpl = fs.readFileSync(path.join(dir, 'templates/cloud/enroll.html'), 'utf8');
assert.match(tpl, /<title>Connect to Coral Hub<\/title>/, 'title');
assert.match(tpl, /<h1>Connect to Coral Hub<\/h1>/, 'heading');
assert.match(tpl, /<p>Enter the code shown on your computer\.<\/p>/, 'intro');
assert.ok(!/Cloud Hub/i.test(tpl), 'no "Cloud Hub" on the page');

// ── 2. prefill ───────────────────────────────────────────────────────
function fakeEl() {
    const el = { value: '', hidden: false, textContent: '', disabled: false, focused: 0, listeners: {} };
    el.focus = () => { el.focused++; };
    el.addEventListener = (ev, fn) => { el.listeners[ev] = fn; };
    el.replaceChildren = () => {};
    el.append = () => {};
    return el;
}

async function runEnroll(search, hookSrc, replyOf) {
    let src = fs.readFileSync(path.join(dir, 'static/cloud/enroll.js'), 'utf8');
    src = src.replace(/^import \{[^}]*\} from '\.\/common\.js';/m, '');
    const els = {};
    const calls = [];
    const sandbox = {
        document: { getElementById: id => (els[id] = els[id] || fakeEl()), createElement: () => fakeEl() },
        location: { pathname: '/enroll', search, replace() {} },
        URLSearchParams, Date, Math, Number, String,
        getSession: async () => ({ authenticated: true, csrf: 'csrf' }),
        postJSON: async (p, body, csrf) => { calls.push([p, body, csrf]); if (p === '/api/enroll/confirm') return replyOf || { status: 200, ok: true, data: { ok: true, secret: 'x' } }; return { status: 200, ok: true, data: { nonce: 'n', requester: { ip: '1.2.3.4', hostname: 'box', coral_version: '1.4.15', requested_at: new Date().toISOString() } } }; },
        setStatus: () => {}, setTimeout, clearTimeout, // Object, JSON and Promise are the context's own: a hook built in the page's realm is a plain object there
        safeNext: (raw, fb) => fb,
    };
    sandbox.window = {};
    const ctx = vm.createContext(sandbox);
    sandbox.window = vm.runInContext('({})', ctx);
    if (hookSrc) vm.runInContext('window.CoralPairing = ' + hookSrc, ctx); // defined in the page's own realm, as a same-origin script would
    vm.runInContext(src, ctx);
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    return { els, calls, ctx };
}

(async () => {
    const withCode = await runEnroll('?code=abcd2345');
    assert.strictEqual(withCode.els.code.value, 'ABCD-2345', '?code= prefills the (normalised) code');
    assert.strictEqual(JSON.stringify(withCode.calls.map(c => c.slice(0, 2))), JSON.stringify([['/api/enroll/preview', { user_code: 'ABCD-2345' }]]), '?code= is looked up at once');

    const without = await runEnroll('');
    assert.strictEqual(without.els.code.value, '', 'no code, nothing prefilled');
    assert.strictEqual(without.calls.length, 0, 'no lookup without a code');
    assert.strictEqual(without.els.code.focused, 1, 'the field is focused');
    // ── 3. the pairing hook (device keys step 1) ──
    const confirmBody = async (hook, reply) => {
        const r = await runEnroll('?code=abcd2345', hook, reply);
        r.els.label.value = 'laptop';
        await r.els.approve.listeners.click();
        for (let i = 0; i < 20; i++) await new Promise(x => setImmediate(x));
        const c = r.calls.find(x => x[0] === '/api/enroll/confirm');
        return { r, c, body: c && JSON.stringify(c[1]) };
    };
    const plain = await confirmBody(null);
    assert.strictEqual(plain.body, JSON.stringify({ user_code: 'ABCD-2345', label: 'laptop', nonce: 'n' }), 'no hook: the confirm body is unchanged');
    assert.strictEqual(plain.c[2], 'csrf');

    // a frozen hook adds listed string fields; user_code, label and nonce cannot be changed or added
    const good = await confirmBody(`Object.freeze({ beforeConfirm(a) { return { device_public_key: 'PUB', device_key_proof: 'SIG', user_code: 'EVIL', label: 'evil', nonce: 'evil', csrf: 'evil', other: 'x' }; } })`);
    assert.strictEqual(good.body, JSON.stringify({ device_public_key: 'PUB', device_key_proof: 'SIG', user_code: 'ABCD-2345', label: 'laptop', nonce: 'n' }), 'a hook only adds listed fields');
    assert.strictEqual(good.c[2], 'csrf', 'the CSRF token still goes in the header');

    // what the hook is handed: a frozen copy of user_code and label only
    const seen = await confirmBody(`Object.freeze({ beforeConfirm(a) { window.__a = a; try { a.label = 'x'; a.nonce = 'n2'; } catch (e) {} return {}; } })`);
    assert.strictEqual(seen.body, JSON.stringify({ user_code: 'ABCD-2345', label: 'laptop', nonce: 'n' }), 'a hook cannot change what it was handed');
    assert.strictEqual(vm.runInContext('Object.keys(window.__a).join()', seen.r.ctx), 'user_code,label', 'the hook is handed user_code and label only');
    assert.strictEqual(vm.runInContext('window.__a.label', seen.r.ctx), 'laptop', 'frozen: it cannot rewrite them');

    // a hook that is not frozen is ignored
    const thawed = await confirmBody(`{ beforeConfirm() { return { device_public_key: 'PUB' }; } }`);
    assert.strictEqual(thawed.body, plain.body, 'an unfrozen hook is ignored');

    // bad returns add nothing: non-string, too long, empty, array, class instance, null, a promise that rejects, a throw
    for (const [name, ret] of [
        ['number', `{ device_public_key: 5 }`], ['too long', `{ device_public_key: 'a'.repeat(2049) }`], ['empty', `{ device_public_key: '' }`],
        ['array', `['PUB']`], ['instance', `new (class X { constructor() { this.device_public_key = 'PUB'; } })()`], ['null', `null`],
        ['inherited', `Object.create({ device_public_key: 'PUB' })`],
    ]) {
        const r = await confirmBody(`Object.freeze({ beforeConfirm() { return ${ret}; } })`);
        assert.strictEqual(r.body, plain.body, `${name}: nothing added`);
    }
    for (const [name, fn] of [['throws', `{ throw new Error('no'); }`], ['rejects', `{ return Promise.reject(new Error('no')); }`]]) {
        const r = await confirmBody(`Object.freeze({ beforeConfirm() ${fn} })`);
        assert.strictEqual(r.body, plain.body, `${name}: the confirm still goes ahead`);
    }
    // a hook that never answers does not hold the confirm for long
    const t0 = Date.now();
    const hang = await confirmBody(`Object.freeze({ beforeConfirm() { return new Promise(() => {}); } })`);
    assert.strictEqual(hang.body, plain.body, 'a hung hook: the confirm still goes ahead');
    assert.ok(Date.now() - t0 < 6000, 'and soon');

    // afterConfirm gets the reply (status, ok, data) as a copy, nothing else; a throw changes nothing
    const after = await confirmBody(`Object.freeze({ afterConfirm(r) { window.__r = JSON.stringify(r); r.data.ok = false; throw new Error('no'); } })`);
    assert.strictEqual(after.body, plain.body);
    assert.strictEqual(vm.runInContext('window.__r', after.r.ctx), '{"status":200,"ok":true,"data":{"ok":true,"secret":"x"}}', 'afterConfirm gets the reply only');
    assert.ok(after.r.els.done.hidden === false, 'a throwing afterConfirm does not stop the done screen');
    console.log('PASS enroll page: Coral Hub wording, ?code= prefill');
})().catch(e => { console.error(e); process.exit(1); });
