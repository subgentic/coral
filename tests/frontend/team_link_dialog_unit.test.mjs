// The Link team dialog's rules (#9888): the Hub's own state words (and none it does not have), a link seen from this team (the two directions of a pair are one row), the computers and teams a link can
// name (online, not this team's computer, not View-only; generated board ids only), the create body for each direction, and our words for a refusal. coral-hub Security's exact sentence is pinned.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const M = await import(path.resolve(here, '../../coral-go/pkg/frontend/static/team_link_dialog.js'));

const own = { server: 's-own', team: 'b-aaaaaaaaaa' };
assert.equal(M.NOT_DELIVERED_SENTENCE, "That team isn't on that computer (it may have been deleted). Revoke this link, and link the team again if it was re-created.");
const N = (source, target) => ({ source, target });
assert.equal(M.stateWord({ notice: N('delivered', 'delivered') }), 'Active');
assert.equal(M.stateWord({ notice: N('delivered', 'not_delivered') }), 'Not delivered', 'either side not delivered is not delivered');
assert.equal(M.stateWord({ notice: N('not_delivered', 'delivered') }), 'Not delivered');
assert.equal(M.stateWord({ notice: N('unavailable', 'delivered') }), 'Active', 'unavailable is not a failure');
assert.equal(M.stateWord({ notice: N('unavailable', 'unavailable') }), 'Active');
assert.equal(M.stateWord({ notice: N('delivered', 'delivered'), legacy: true }), 'Old-style, create again');
assert.equal(M.stateWord({}), '', 'no notice: no word is made up');
for (const bad of ['pending', 'revoked', 'delivered']) assert.equal(M.stateWord({ notice: bad }), '', JSON.stringify(bad) + ' is not the Hub notice shape');

const links = [
    { id: 1, src_server_id: 's-own', src_team: 'b-aaaaaaaaaa', dst_server_id: 's-two', dst_team: 'b-bbbbbbbbbb', dst_team_label: 'qa-team', notice: N('delivered', 'delivered') },
    { id: 2, src_server_id: 's-two', src_team: 'b-bbbbbbbbbb', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'qa-team', notice: N('delivered', 'delivered') },
    { id: 3, src_server_id: 's-three', src_team: 'b-cccccccccc', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'ops', notice: N('delivered', 'not_delivered') },
    { id: 4, src_server_id: 's-x', src_team: 'b-xxxxxxxxxx', dst_server_id: 's-y', dst_team: 'b-yyyyyyyyyy', notice: N('delivered', 'delivered') },
];
const rows = M.rowsFor(links).map(l => M.linkRow(l, own)).filter(Boolean);
assert.equal(rows.length, 3, 'a link that names neither end as this team is not shown; each direction of a pair is its own row, with its own id (Revoke per row)');
assert.deepEqual(rows.map(r => r.id), [1, 2, 3]);
assert.deepEqual([rows[0].end.team, rows[0].mayMessageUs, M.directionWords(rows[0])], ['b-bbbbbbbbbb', false, 'This team may message it']);
assert.deepEqual([rows[1].end.team, rows[1].mayMessageUs, M.directionWords(rows[1])], ['b-bbbbbbbbbb', true, 'May message this team']);
assert.deepEqual([rows[2].end.label, rows[2].state, rows[2].notDelivered], ['ops', 'Not delivered', true]);

const live = { servers: [{ id: 's-two', version: '2.0.3', coral_version: '2.0.3', below_minimum: false, min_coral: '' }, { id: 's-old', version: '2.0.2<img>', hostile: 'x' }], sessions: [{ name: 'HOSTILE' }] };
const by = M.liveVersions(live);
assert.deepEqual([...by.keys()], ['s-two', 's-old'], 'only servers[] is read');
assert.ok(!JSON.stringify([...by.values()]).includes('HOSTILE') && !JSON.stringify([...by.values()]).includes('hostile'), 'nothing else of the answer is kept');
assert.equal(M.liveVersions({ sessions: [] }), null, 'no servers[]: the version is unknown');
assert.deepEqual(M.withVersions([{ id: 's-two', label: 'two' }, { id: 's-x' }], by)[0].version, '2.0.3');
assert.deepEqual(M.withVersions([{ id: 's-x' }], null), [{ id: 's-x' }], 'unknown versions leave the rows as they are');
assert.ok(M.meetsLinkVersion({ id: 'z' }, false) && !M.meetsLinkVersion({ id: 'z', below_minimum: true }, false), 'a failed read does not block the form, but a below-minimum flag still does');
const servers = [{ id: 's-own', online: true, version: '2.0.3' }, { id: 's-two', label: 'two', online: true, effective_mode: 'interact', coral_version: '2.0.3' }, { id: 's-view', online: true, effective_mode: 'view', version: '2.0.3' }, { id: 's-off', online: false, version: '2.0.3' }, { id: 's-launch', online: true, access_mode: 'launch', version: '2.1.0-dev+abc.dirty' }, { id: 's-old', label: 'old', online: true, version: '2.0.2' }, { id: 's-none', online: true }, { id: 's-below', online: true, version: '2.0.9', below_minimum: true }];
assert.deepEqual(M.pickableComputers(servers, 's-own').map(s => s.id), ['s-two', 's-launch'], 'online, not this computer, not View-only, on the linking version or later');
assert.deepEqual(M.olderComputers(servers, 's-own').map(s => s.id), ['s-old', 's-none', 's-below'], 'an older, unknown or below-minimum computer needs an update and is never a target');
assert.ok(M.meetsLinkVersion({ version: 'v2.0.3' }) && !M.meetsLinkVersion({ version: '2.0.2' }) && M.meetsLinkVersion({ version: '2.10.0' }) && !M.meetsLinkVersion({ version: '1.99.99' }));
assert.deepEqual(M.pickableTeams([{ project: 'b-abcde12345', board_label: 'alpha' }, { project: 'legacy_board' }, { project: 'b-short' }]), [{ id: 'b-abcde12345', label: 'alpha' }], 'a name is not a team id a link can use');

const other = { server: 's-two', team: 'b-bbbbbbbbbb' };
assert.deepEqual(M.createBody('they', own, other), { src_server_id: 's-two', src_team: 'b-bbbbbbbbbb', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', both_directions: false });
assert.deepEqual(M.createBody('we', own, other), { src_server_id: 's-own', src_team: 'b-aaaaaaaaaa', dst_server_id: 's-two', dst_team: 'b-bbbbbbbbbb', both_directions: false });
assert.equal(M.createBody('both', own, other).both_directions, true);

assert.match(M.errorWords(404), /not View-only/); assert.match(M.errorWords(409, 'relay_off'), /turned off/); assert.match(M.errorWords(400, 'legacy_board'), /old-style name/); assert.match(M.errorWords(429), /Too many changes/); assert.match(M.errorWords(409, 'link_limit'), /most links it allows. A Both ways link uses two/); assert.match(M.errorWords(0), /Could not reach/);
console.log('team_link_dialog_unit: ok');
