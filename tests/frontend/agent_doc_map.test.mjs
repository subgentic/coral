// Where the robot "Copy for an agent" buttons point (#15063): every entry of DOC_POINTERS names a topic that exists in coral-go/agent_docs/ and a heading that exists in it (a heading's "(#1234)" tag is not part of its name),
// and the line it makes is the one the Operator reads on screen. A heading renamed or a doc removed fails here, not on an agent's first try.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_POINTERS, pointerLine, agentCopyText } from '../../coral-go/pkg/frontend/static/agent_doc_map.js';

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/agent_docs');
const headings = topic => fs.readFileSync(path.join(docs, `${topic}.md`), 'utf8').split('\n').filter(l => /^#{1,4} /.test(l)).map(l => l.replace(/^#+\s*/, '').replace(/\s*\(#\d+\)\s*$/, '').trim());

const missing = [];
for (const [key, { topic, section }] of Object.entries(DOC_POINTERS)) {
    if (!fs.existsSync(path.join(docs, `${topic}.md`))) { missing.push(`${key}: no agent_docs/${topic}.md`); continue; }
    if (section && !headings(topic).includes(section)) missing.push(`${key}: agent_docs/${topic}.md has no heading "${section}"`);
}
assert.deepEqual(missing, [], 'every robot button points at a real heading: ' + missing.join('; '));
assert.ok(Object.keys(DOC_POINTERS).length >= 15, 'the places the Operator asked for are all mapped');

assert.equal(pointerLine('board', 'Goals'), 'Docs: coral-agent docs board, section “Goals”');
assert.equal(pointerLine('resource-queue'), 'Docs: coral-agent docs resource-queue', 'no section: the topic alone');
assert.equal(agentCopyText('goal', 'Goal #65 (Fast releases): run coral-board goal brief 65'), 'Goal #65 (Fast releases): run coral-board goal brief 65\nDocs: coral-agent docs board, section “Goals”', 'the command, then where to read');
assert.equal(agentCopyText({ topic: 'hub', section: 'Proxy' }, ''), 'Docs: coral-agent docs hub, section “Proxy”', 'a page being read (the Docs viewer): no subject, just the place');
assert.equal(agentCopyText('nope', 'x'), 'x', 'an unknown key copies the subject alone');
console.log('agent_doc_map: ok');
