// #13209 (goal #218): the Info dialog's Skills and Memory rows say what the routes answer, as text, and say nothing when there is no answer.
//   node agent_info_sections.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const m = await importUi('agent_info_sections');
assert.deepEqual(m.skillLines(null), [], 'no answer: the row stays hidden');
assert.deepEqual(m.skillLines({ error: 'x' }), []);
assert.deepEqual(m.skillLines({ skills: [] }), ['None loaded yet']);
assert.deepEqual(m.skillLines({ skills: [{ name: 'notes', version: 2, loads: 3, status: 'approved' }, { name: 'old', version: 1, loads: 1, status: 'removed' }, { name: 'fresh', version: 1, loads: 2, status: 'approved', newer_version: true }] }),
    ['notes v2, loaded 3 times', 'old v1, loaded 1 time, removed', 'fresh v1, loaded 2 times, newer version approved']);
assert.deepEqual(m.memoryItems(undefined), []);
assert.deepEqual(m.memoryItems({ files: [] }), [{ id: '', label: 'None found' }]);
assert.deepEqual(m.memoryItems({ files: [{ id: 'a'.repeat(32), file: 'CLAUDE.md', kind: 'instructions', level: 'project' }, { id: 'b', file: 'x.md', kind: 'memory', level: 'user', problem: 'unreadable' }] }),
    [{ id: 'a'.repeat(32), label: 'CLAUDE.md: instructions, project' }, { id: '', label: 'x.md: memory, user (unreadable)' }]);
assert.equal(m.memoryText(null), 'This file could not be read.');
assert.equal(m.memoryText({ text: 'hello' }), 'hello');
assert.match(m.memoryText({ text: 'hello', truncated: true }), /^hello\n\n\[cut/);
assert.equal(m.memoryText({ binary: true }), 'This file is not text.');
assert.match(m.memoryText({ problem: 'link' }), /cannot be shown \(link\)/);
console.log('agent_info_sections: ok');
