import assert from 'node:assert/strict';
import { spawnSync } from './helpers/child_process.js';
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const scenario = process.argv[2];
if (!scenario) {
    for (const name of ['local', 'self-hosted', 'refused', 'error', 'array', 'true']) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8' });
        assert.equal(r.status, 0, name + '\n' + r.stdout + r.stderr);
    }
    console.log('cloud_account_flags: ok');
} else {
    const cloud = !['local', 'self-hosted'].includes(scenario);
    const dom = installDom({ mode: cloud ? 'cloud' : 'local', boot: { inbox: 'native', needs: 'native', goal_preview: true } });
    let calls = 0;
    globalThis.fetch = window.fetch = async url => {
        calls++; assert.equal(url, '/api/account');
        if (scenario === 'error') throw new Error('offline');
        return { ok: scenario !== 'refused', json: async () => scenario === 'array' ? [{ needs_native: true, goal_preview: true }] : { needs_native: true, goal_preview: true } };
    };
    const base = await importUi('server_base');
    const { state } = await importUi('state');
    if (scenario === 'self-hosted') state.hub = true;
    assert.equal(base.nativeNeeds(), false, 'boot never enables per-account flags');
    assert.equal(base.goalPreviewOn(), false);
    await base.initCloudAccountFlags();
    await base.initCloudAccountFlags();
    assert.equal(calls, cloud ? 1 : 0, 'cached account read only in cloud mode');
    assert.equal(base.nativeNeeds(), scenario === 'true');
    assert.equal(base.goalPreviewOn(), scenario === 'true');
    dom.window.close();
}
