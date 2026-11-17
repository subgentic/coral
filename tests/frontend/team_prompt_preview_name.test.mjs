// #19071 (walk 75 L14): the Prompts preview is built with the team's board id; the page shows the team's name, or "this team" when the team has only its id.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { nameTheTeam } = await importUi('team_working_mode');
const id = 'b-pw7by4csxh';
const data = { orchestrator: { effective_system: `Join board ${id} as Orchestrator. "${id}"`, override: '' }, worker: { effective_action: `Post to ${id}` } };
const named = nameTheTeam(data, id, 'Skyline "Studio"');
assert.equal(named.orchestrator.effective_system, 'Join board Skyline "Studio" as Orchestrator. "Skyline "Studio""', 'every id is the team name, quotes kept as text');
assert.equal(named.worker.effective_action, 'Post to Skyline "Studio"');
assert.equal(nameTheTeam(data, id, id).worker.effective_action, 'Post to this team', 'a team with only its id reads "this team"');
assert.equal(nameTheTeam(data, id, '').worker.effective_action, 'Post to this team');
assert.equal(nameTheTeam(data, 'skyline', 'Skyline'), data, 'an older board whose key is its name is not rewritten');
assert.equal(JSON.stringify(data).includes(id), true, 'the input is not changed');
// #19121: a name with a control character, a backslash or a line break is plain text in the preview (the id is replaced in the strings, there is no JSON round trip to break)
for (const odd of ['A\u0001B', 'back\\slash "q"', 'two\nlines', '\u2028x']) assert.equal(nameTheTeam(data, id, odd).worker.effective_action, 'Post to ' + odd, JSON.stringify(odd));
const nested = { a: [{ b: `x ${id}` }, 3, null, true], c: { d: id } };
assert.deepEqual(nameTheTeam(nested, id, 'T'), { a: [{ b: 'x T' }, 3, null, true], c: { d: 'T' } }, 'arrays, numbers, null and nested objects are walked');
const { renderInspection } = await importUi('team_working_mode');
assert.match(renderInspection(data, {}, { id, name: 'Skyline' }), /Team names are shown in place of the team's id/, 'the preview says the names stand for the id');
assert.doesNotMatch(renderInspection(data, {}), /Team names are shown/, 'no note when nothing was replaced');
console.log('team_prompt_preview_name: ok');
