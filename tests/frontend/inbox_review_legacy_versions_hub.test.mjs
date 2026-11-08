// Earlier-version expansion uses versions=all, which the Hub tunnel does not allow. Fail closed before sending the unsupported query.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'cloud' });
const server = await importUi('server_base');
assert.equal(server.isCloud(), true);
const { state } = await importUi('state');
state.hub = true;
state.servers = [{ id: 'srv1', status: 'online' }];
const reads = [];
globalThis.fetch = window.fetch = async url => {
    reads.push(String(url));
    return Response.json({ artifacts: [], has_more: false });
};

const reviews = await importUi('inbox_reviews');
const row = {
    team: '@srv1/dev', name: 'Plan.md', produced_by: 'Writer',
    session_id: 'writer-session', hex: 'a'.repeat(64),
    created_at: '2026-11-06T10:00:00Z',
};
await assert.rejects(reviews.legacyEarlierVersions(row), /Earlier versions aren't available through Coral Hub/);
assert.deepEqual(reads, [], 'Hub mode must not send versions=all (or any partial earlier-version query)');
console.log('inbox_review_legacy_versions_hub: ok');
