// How a dialog or a toast names an agent and says what stays (#10139): its role and team, never the folder it happens to work in.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { agentWords, WHAT_STAYS_KILL, WHAT_STAYS_KILL_MANY, WHAT_STAYS_RESET, WHAT_STAYS_ARCHIVE, whatStaysKill, whatStaysReset, deleteTeamWords, unpinWords } = await import(pathToFileURL(path.resolve(here, '../../coral-go/pkg/frontend/static/agent_words.js')).href);

// role and team
let w = agentWords({ board_job_title: 'QA Engineer', board_project: 'alpha', name: 'work-claude-1', working_directory: '/x/work' }, 'work');
assert.deepEqual([w.role, w.team, w.label], ['QA Engineer', 'alpha', 'QA Engineer in alpha'], 'the role and the team, not the folder name');
// no team: the role alone; no role: the identity the row shows; nothing: a plain word
assert.equal(agentWords({ board_job_title: 'Lead Developer' }).label, 'Lead Developer');
assert.equal(agentWords({ board_project: 'alpha' }, 'Backend Dev').label, 'Backend Dev in alpha');
assert.equal(agentWords({}, '').label, 'this agent');
assert.equal(agentWords(null, 'Claude').label, 'Claude');
// a team on another computer is named by its label, not its key
assert.equal(agentWords({ board_job_title: 'QA Engineer', board_project: 'alpha', server: 'ws1' }).label, 'QA Engineer in alpha');
// whitespace and control characters never reach a dialog
assert.equal(agentWords({ board_job_title: '  QA\n  Engineer  ' }).role, 'QA Engineer');

// what stays
assert.match(WHAT_STAYS_KILL, /chat/i); assert.match(WHAT_STAYS_KILL, /History/);
assert.match(WHAT_STAYS_ARCHIVE, /chat history and files stay/i); assert.match(WHAT_STAYS_ARCHIVE, /Unarchive brings it back/i);

// #11956: a Hermes agent keeps its conversation in a Hermes home of its own, deleted with the agent (Hermes keeps no other copy): the kill and reset words must not promise History for it
const hermes = { agent_type: 'hermes' }, claude = { agent_type: 'claude' };
assert.equal(whatStaysKill([claude]), WHAT_STAYS_KILL, 'one agent that is not Hermes: as before');
assert.equal(whatStaysKill([claude, claude]), WHAT_STAYS_KILL_MANY);
assert.equal(whatStaysKill([]), WHAT_STAYS_KILL_MANY, 'nothing to say about no agents, and no Hermes claim');
assert.match(whatStaysKill([hermes]), /conversation is deleted with it/i); assert.match(whatStaysKill([hermes]), /no other copy/i); assert.doesNotMatch(whatStaysKill([hermes]), /History/);
assert.match(whatStaysKill([hermes, hermes]), /conversations are deleted with them/i); assert.doesNotMatch(whatStaysKill([hermes, hermes]), /History/);
const mixed = whatStaysKill([claude, hermes, hermes]);
assert.match(mixed, /Their chats stay in History/); assert.match(mixed, /except the 2 Hermes agents/i); assert.match(mixed, /no other copy/i);
assert.match(whatStaysKill([claude, hermes]), /except the 1 Hermes agent\b/i, 'singular');
assert.equal(whatStaysReset([claude]), WHAT_STAYS_RESET);
assert.match(whatStaysReset([claude, hermes]), /old chats stay in History/i); assert.match(whatStaysReset([claude, hermes]), /Hermes agent's old conversation is the exception: it is deleted/i); assert.match(whatStaysReset([claude, hermes]), /no other copy/i);

// team delete: what is lost, what stays, and that the folder is untouched
const d = deleteTeamWords('alpha');
assert.match(d, /Delete team "alpha"\?/); for (const lost of ['messages', 'tasks', 'goals', 'members', 'reminders', 'waits', 'presets', 'settings', 'artifact tags', 'health data']) assert.match(d, new RegExp('\\b' + lost + '\\b', 'i'), 'what the delete removes is listed: ' + lost); assert.match(d, /cannot be undone/i);
assert.match(d, /chats stay in History/i); assert.match(d, /files in the team's folder are not touched/i);
// agents still running: said in a dialog, with the way out
const r = deleteTeamWords('alpha', ['QA Engineer', 'Lead Developer']);
assert.match(r, /alpha still has 2 agents running: QA Engineer, Lead Developer/); assert.match(r, /kill them or move them/i); assert.match(r, /nothing was deleted/i);
assert.match(deleteTeamWords('alpha', ['QA Engineer']), /still has 1 agent running: QA Engineer/);
assert.match(deleteTeamWords('alpha', ['a', 'b', 'c', 'd', 'e', 'f']), /a, b, c, d, e and 1 more/);

// unpin
assert.equal(unpinWords('/home/user/work'), 'Removed work from your list. Its files were not changed.');
assert.equal(unpinWords(''), 'Removed the folder from your list. Its files were not changed.');
console.log('agent_words: ok');
