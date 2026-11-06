import assert from 'node:assert/strict';
import { spawnSync } from './helpers/child_process.js';
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const cases = {
    true: { account: { needs_native: true, goal_preview: true }, boot: false, expected: [true, true] },
    false: { account: { needs_native: false, goal_preview: false }, boot: true, expected: [false, false] },
    absent: { account: {}, boot: true, expected: [true, true] },
    'absent-off': { account: {}, boot: false, expected: [false, false] },
    error: { boot: true, expected: [true, true] },
    refused: { boot: true, expected: [true, true] },
    array: { account: [{ needs_native: false, goal_preview: false }], boot: true, expected: [true, true] },
    malformed: { account: { needs_native: 'true', goal_preview: 1 }, boot: true, expected: [true, true] },
    'needs-only': { account: { needs_native: false }, boot: true, expected: [false, true] },
    'goals-only': { account: { goal_preview: false }, boot: true, expected: [true, false] },
    hung: { boot: true, expected: [true, true] },
    local: { boot: true, expected: [false, false] },
    'self-hosted': { boot: true, expected: [false, false] },
};
const scenario = process.argv[2];
if (!scenario) {
    let failures = 0;
    for (const name of Object.keys(cases)) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8' });
        if (r.status) { failures++; console.error(name + '\n' + r.stdout + r.stderr); }
        else console.log('PASS account flags ' + name);
    }
    assert.equal(failures, 0, 'account flag cases failed');
} else {
    const c = cases[scenario], cloud = !['local', 'self-hosted'].includes(scenario);
    const dom = installDom({ mode: cloud ? 'cloud' : 'local', boot: { inbox: 'native', needs: c.boot ? 'native' : 'frame', goal_preview: c.boot } });
    let calls = 0, release;
    globalThis.fetch = window.fetch = async url => {
        calls++; assert.equal(url, '/api/account');
        if (scenario === 'hung') return new Promise(resolve => { release = resolve; });
        if (scenario === 'error') throw new Error('offline');
        return { ok: scenario !== 'refused', json: async () => c.account };
    };
    const base = await importUi('server_base');
    const { state } = await importUi('state');
    if (scenario === 'self-hosted') state.hub = true;
    if (scenario === 'hung') {
        const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
        let expire, cleared = false;
        globalThis.setTimeout = (fn, ms) => { assert.ok(ms >= 1000 && ms <= 5000); expire = fn; return -99; };
        globalThis.clearTimeout = id => { if (id === -99) cleared = true; else realClear(id); };
        try {
            const init = base.initCloudAccountFlags();
            assert.equal(typeof expire, 'function'); expire(); await init;
            release({ ok: true, json: async () => ({ needs_native: false, goal_preview: false }) });
            await Promise.resolve(); await Promise.resolve();
            assert.equal(cleared, true);
        } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
    } else { await base.initCloudAccountFlags(); await base.initCloudAccountFlags(); }
    assert.equal(calls, cloud ? 1 : 0, 'one cached account read, only in cloud');
    assert.deepEqual([base.nativeNeeds(), base.goalPreviewOn()], c.expected, 'explicit booleans win; otherwise boot survives');
    dom.window.close();
}
