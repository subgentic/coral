// The server's sentences for a CLI found and not used and what the page reads out of them stay one thing (#12364): tests/frontend/fixtures/cli_refusal_sentences.json is the one copy; the Go test builds each
// sentence from the server's own code and must get 'note' exactly; this reads each 'note' with the page's parser and must get 'expect'. A wording change on either side fails one of the two.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { refusedWords } from '../../coral-go/pkg/frontend/static/cli_refused_words.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'cli_refusal_sentences.json'), 'utf8'));
assert.ok(cases.length >= 5, 'the fixture has the agent, temp, data, Hub and unknown wordings');
for (const c of cases) assert.deepEqual(refusedWords(c.note), c.expect, `the page reads "${c.name}"`);
assert.deepEqual(refusedWords(''), { path: '', kind: 'other', agent: '', folder: '' }, 'nothing at all is the generic wording');
console.log('cli_refusal_words: ' + cases.length + ' sentences read as the fixture says');
