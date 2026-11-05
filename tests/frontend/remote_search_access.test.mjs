import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
const { registerBundled } = await importUi('import_once');
registerBundled({ 'team_table.js': { stateChip: text => document.createTextNode(text) } });
const { state } = await importUi('state');
const { openSearchAccess, readSearchLevels } = await importUi('search_access');
const calls = [];
globalThis.fetch = window.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (String(url).includes('/teams/detail/')) return Response.json({ members: [{ id: 7, agent_name: 'Writer', search_reach: 'own' }] });
    return Response.json({ ok: true, rows: [] });
};
test('a remote search level save stays on its team computer, even with a local member sharing the id', async () => {
    state.hub = false; calls.length = 0;
    const levels = await readSearchLevels('@m1/dev');
    const changed = new Promise(resolve => openSearchAccess({ name: 'Writer', team: '@m1/dev', ...levels.get('Writer') }, { onChanged: resolve }));
    const radio = document.querySelector('input[value="team"]'); radio.checked = true; radio.dispatchEvent(new Event('change'));
    document.querySelector('#search-access-dialog .btn-primary').click();
    await changed;
    assert.equal(calls.find(c => c.method === 'PUT').url, '/api/remote/m1/api/team-members/7/search-access');
    assert.equal(calls.find(c => c.url.includes('/teams/detail/')).url, '/api/remote/m1/api/teams/detail/dev');
    assert.deepEqual(JSON.parse(calls.find(c => c.method === 'PUT').body), { level: 'team' });
    assert.equal(calls.find(c => c.url.includes('/search-access/log')).url, '/api/remote/m1/api/search-access/log?limit=100');
});
test('self-hosted Hub search access is read-only by default', () => {
    state.hub = true; calls.length = 0;
    openSearchAccess({ name: 'Writer', team: '@m1/dev', id: 7, level: 'own' });
    assert.equal(document.querySelector('#search-access-dialog input[type="radio"]'), null);
    assert.equal(document.querySelector('#search-access-dialog .btn-primary'), null);
    assert.match(document.querySelector('#search-access-dialog').textContent, /computer's own dashboard/);
    assert.equal(calls.length, 0);
});
