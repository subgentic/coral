// A task's page in the person's words (#10603, the Beta tester): the agent's own instructions are "Instructions for the agent" (a workflow with a name keeps its name), and a result names a file the task attached
// (hours.md) as a link to it. Pure functions of task_detail_html.js, run in a vm with its helpers stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../../coral-go/pkg/frontend/static/task_detail_html.js'), 'utf8');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const context = vm.createContext({
  escapeHtml: escape, escapeAttr: escape, _priorityRank: {}, formatTaskDate: String, _verifyLine: () => '', whenWords: String,
  _getBoardProject: () => 'p', boardKeyName: String, keyLabel: String, identityKey: String, splitKey: () => ({ server: '' }),
  formatCost: String, _formatTokenCount: String, _priorityLabel: String, _claimedFor: () => '', serverUrl: String, artifactPath: String, contextServer: () => '', reviewPoolInfo: () => null,
});
vm.runInContext(source.slice(source.indexOf('function _messageWithFiles(')).replaceAll('export function', 'function'), context);
const HEX = 'a'.repeat(64);

let html = context._taskWorkflowHtml({ id: 1, workflow: { instructions: 'Write the hours report.' } });
assert.ok(/<summary>Instructions for the agent<\/summary>/.test(html), 'the agent\'s own instructions are named for what they are: ' + html.slice(0, 200));
html = context._taskWorkflowHtml({ id: 1, workflow: { name: 'release', stage: 'build', instructions: 'x' } });
assert.ok(/<summary>Workflow: release · build<\/summary>/.test(html), 'a workflow with a name keeps it');

const art = [{ name: 'hours.md', uri: 'coral://artifacts/' + HEX }, { name: 'notes.txt', uri: 'https://example.com/n.txt' }];
let m = context._messageWithFiles('Done. Wrote hours.md and notes.txt for the team.', art);
assert.ok(m.includes('data-artifact-uri="coral://artifacts/' + HEX + '"') && m.includes('>hours.md</a>'), 'a coral file is a link that opens it: ' + m);
assert.ok(m.includes('<a href="https://example.com/n.txt"') && m.includes('>notes.txt</a>'), 'a web file is a link: ' + m);
assert.ok(m.startsWith('Done. Wrote ') && m.endsWith(' for the team.'), 'the other words are as written: ' + m);
assert.equal(context._messageWithFiles('Wrote hours.md, then hours.md again', art).match(/<a /g).length, 1, 'the first mention is the link');
assert.equal(context._messageWithFiles('<b>hours.md</b>', [{ name: 'x', uri: 'coral://artifacts/' + HEX }]), '&lt;b&gt;hours.md&lt;/b&gt;', 'text is escaped, and a one-letter name is not a link');
assert.equal(context._messageWithFiles('Wrote hours.md', [{ name: 'hours.md', uri: 'javascript:alert(1)' }]), 'Wrote hours.md', 'only a coral or web address is linked');
console.log('task_detail_words: ok');
