// team_artifact_filters.js: the Starred filter (#9819): a flag that becomes starred=true on the list route, has its chip, and is part of the Inbox's filters too.
import assert from 'node:assert/strict';

globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const TF = await import('../../coral-go/pkg/frontend/static/team_artifact_filters.js');

assert.equal(TF.EMPTY.starred, false, 'off by default');
assert.equal(TF.toParams({ ...TF.EMPTY, starred: true }).starred, 'true');
assert.equal('starred' in TF.toParams(TF.EMPTY), false, 'nothing set sends nothing');
assert.equal(TF.toParams({ ...TF.EMPTY, starred: true, kept: true }).kept, 'true', 'it combines with Kept');
assert.ok(TF.isFiltered({ ...TF.EMPTY, starred: true }), 'a starred-only list is a filtered one');
assert.ok(TF.chips({ ...TF.EMPTY, starred: true }).some(c => c.label === 'Starred'), 'its chip says Starred');
assert.equal(TF.clean({ starred: 'yes' }).starred, false, 'only a real boolean counts');
assert.equal(TF.INBOX.EMPTY.starred, false, 'the Inbox list has it too');
assert.equal(TF.toParams({ ...TF.INBOX.EMPTY, starred: true }).starred, 'true');
console.log('team_artifact_filters_starred: ok');
