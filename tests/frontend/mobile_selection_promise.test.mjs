// #8208: callers awaiting selection must wait for the asynchronous team exit.
// Evaluate the actual module definitions with browser imports supplied as fakes;
// the wrapper body itself is neither copied nor rewritten.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/mobile.js', import.meta.url), 'utf8')
    .replace(/^import .* from .*;\s*$/gm, '')
    .replace(/^export /gm, '');
function browser(mobile, original) {
    const classes = (...names) => {
        const set = new Set(names);
        return { remove: name => set.delete(name), contains: name => set.has(name) };
    };
    const list = { style: {} }, panel = { classList: classes('mobile-panel-overlay') };
    const sidebar = { classList: classes('tablet-open') }, backdrop = { classList: classes('active') };
    const toggles = [];
    const window = { selectLiveSession: original, toggleAgenticPanel: value => toggles.push(value) };
    const context = vm.createContext({ window, isPhoneLayout: () => mobile, document: {
        getElementById: id => ({ 'mobile-agent-list': list, 'agentic-state': panel }[id] || null),
        querySelector: selector => ({ '.sidebar': sidebar, '.tablet-sidebar-backdrop': backdrop }[selector] || null),
    } });
    vm.runInContext(source, context, { filename: 'mobile.js' });
    vm.runInContext('wrapSelectLiveSession()', context);
    return { window, list, panel, sidebar, backdrop, toggles };
}

for (const mobile of [false, true]) {
    let release, navigated = false, callerFinished = false;
    const calls = [];
    const navigation = new Promise(resolve => { release = () => { navigated = true; resolve('selected'); }; });
    const b = browser(mobile, (...args) => { calls.push(args); return navigation; });
    const caller = (async () => {
        const result = await b.window.selectLiveSession('agent', 'codex', 'session', 'computer');
        assert.equal(navigated, true, 'awaiting selection must wait for the real navigation');
        callerFinished = true;
        return result;
    })();
    // Attach a rejection handler before yielding, including on the failing-first run.
    const outcome = caller.then(value => ({ value }), error => ({ error }));
    await Promise.resolve();
    assert.equal(callerFinished, false, 'navigation is still held');
    assert.deepEqual(calls, [['agent', 'codex', 'session', 'computer']]);
    assert.equal(b.sidebar.classList.contains('tablet-open'), false);
    assert.equal(b.backdrop.classList.contains('active'), false);
    assert.equal(b.list.style.display, mobile ? 'none' : undefined);
    assert.equal(b.panel.classList.contains('mobile-panel-overlay'), !mobile);
    assert.deepEqual(b.toggles, mobile ? [false] : []);
    release();
    const result = await outcome;
    if (result.error) throw result.error;
    assert.equal(result.value, 'selected', 'selection result reaches its caller');
    assert.equal(callerFinished, true);
}

// A rejected team-exit/navigation operation stays a rejection for its caller.
const failure = new Error('navigation refused');
const rejected = browser(false, () => Promise.reject(failure));
await assert.rejects(rejected.window.selectLiveSession('a', 'codex', 'id', 'local'), error => error === failure);
const cancelled = browser(false, () => false);
assert.equal(cancelled.window.selectLiveSession('a', 'codex', 'id', 'local'), false, 'synchronous cancellation is preserved');
const missing = browser(false, undefined);
assert.equal(missing.window.selectLiveSession, undefined, 'no selector is installed when none exists');
console.log('mobile selection promise: PASS (desktop, phone, result, rejection, cancellation, existing UI effects)');
