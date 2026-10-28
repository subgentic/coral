// The Knowledge tab's text helpers (#7761): the front matter of an entry, the file name an agent's notes get, and the entry a relative link names. Pure functions (knowledge_text.js).
import assert from 'node:assert/strict';
import { splitFrontMatter, slugOf, entryForLink, withTeamLabel } from '../../coral-go/pkg/frontend/static/knowledge_text.js';

const okf = '---\ntype: Team Knowledge Bundle\ntitle: coral-go-team\ndescription: Distilled institutional knowledge for team coral-go-team\ntags: [orchestrator, lead-developer, "qa-engineer"]\ntimestamp: 2026-10-22T04:22:31Z\n---\n\n# coral-go-team\n\n## Agents\n';
const a = splitFrontMatter(okf);
assert.deepEqual(a.facts, { type: 'Team Knowledge Bundle', title: 'coral-go-team', description: 'Distilled institutional knowledge for team coral-go-team', tags: ['orchestrator', 'lead-developer', 'qa-engineer'], timestamp: '2026-10-22T04:22:31Z' });
assert.equal(a.body, '# coral-go-team\n\n## Agents\n', 'the body starts at the first line after the block and its blank line');
assert.equal(splitFrontMatter(okf.replace(/\n/g, '\r\n')).facts.title, 'coral-go-team', 'CRLF text reads the same');
assert.equal(splitFrontMatter('\uFEFF' + okf).facts.type, 'Team Knowledge Bundle', 'a byte order mark is ignored');
assert.deepEqual(splitFrontMatter('# Index\nWhat the team knows.').facts, null, 'text without a block has no facts');
assert.equal(splitFrontMatter('# Index\nWhat the team knows.').body, '# Index\nWhat the team knows.');
assert.equal(splitFrontMatter('---\nNot closed for a long time\n' + 'x\n'.repeat(60)).facts, null, 'a --- with no closing one nearby is a rule, not a block');
assert.equal(splitFrontMatter('---\ntype: Note\n---\n').body, '', 'a text of only a block has an empty body');
assert.deepEqual(splitFrontMatter('---\ntags: a, b\n---\nx').facts.tags, ['a', 'b'], 'tags without brackets');
assert.equal(splitFrontMatter('---\nunknown: 1\ntype: T\n---\nx').facts.type, 'T', 'an unknown key is skipped');
assert.equal(splitFrontMatter(null).body, '');

assert.equal(slugOf('Backend Dev'), 'backend-dev');
assert.equal(slugOf('UX/UX Engineer'), 'uxux-engineer', 'a slash is dropped, as the distillation does');
assert.equal(slugOf('Security Reviewer Windows'), 'security-reviewer-windows');

const entries = [{ key: 'index', name: 'Index' }, { key: 'agent:Backend Dev', name: 'Backend Dev' }, { key: 'agent:UX/UX Engineer', name: 'UX/UX Engineer' }, { key: 'agent:con', name: 'con' }];
assert.equal(entryForLink('./backend-dev.md', entries).key, 'agent:Backend Dev');
assert.equal(entryForLink('../uxux-engineer.md', entries).key, 'agent:UX/UX Engineer');
assert.equal(entryForLink('./BACKEND-DEV.md', entries).key, 'agent:Backend Dev', 'case does not matter');
assert.equal(entryForLink('./con_.md', entries).key, 'agent:con', 'a Windows device name carries a trailing underscore');
assert.equal(entryForLink('./index.md', entries).key, 'index');
for (const bad of ['./nobody.md', 'https://example.com/backend-dev.md', '/backend-dev.md', './sub/backend-dev.md', './backend-dev.md#x', './backend-dev.txt', '..\\backend-dev.md', 'javascript:alert(1)', '']) assert.equal(entryForLink(bad, entries), null, `${bad} names no entry`);
console.log('knowledge_text: ok');

// the index says the team's name, not its board id (#10376, the Mobile tester: a page titled "b-p23b3rfwea — Team Knowledge" for the team demo)
assert.equal(withTeamLabel('# b-p23b3rfwea \u2014 Team Knowledge\n\nAuto-distilled from agent session histories.\n', 'b-p23b3rfwea', 'demo'), '# demo \u2014 Team Knowledge\n\nAuto-distilled from agent session histories.\n', 'the first heading names the team');
assert.equal(withTeamLabel('title: b-p23b3rfwea', 'b-p23b3rfwea', 'demo'), 'title: demo', 'a title line is the team too');
assert.equal(withTeamLabel('# Index\nWhat b-p23b3rfwea knows.', 'b-p23b3rfwea', 'demo'), '# Index\nWhat b-p23b3rfwea knows.', 'only the heading and the title are changed, never the body');
assert.equal(withTeamLabel('# x', '', 'demo'), '# x', 'no id, no change');
assert.equal(withTeamLabel('# a.b \u2014 Team Knowledge', 'a.b', 'demo'), '# demo \u2014 Team Knowledge', 'an id with a dot is matched as text, not a pattern');
console.log('knowledge_text: ok');
