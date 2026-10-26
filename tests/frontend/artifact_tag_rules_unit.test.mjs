// The dashboard's artifact-tag rules (artifact_tag_rules.js) against the table the server's normalizer is tested with (fixtures/artifact_tag_cases.json, #8673): one list of cases, so the two cannot drift.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTag, MAX_LEN, MAX_TAGS } from '../../coral-go/pkg/frontend/static/artifact_tag_rules.js';

const table = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'artifact_tag_cases.json'), 'utf8'));
assert.ok(table.tags.length > 0, 'an empty table pins nothing');
assert.equal(MAX_LEN, table.max_len, 'the length limit is the server\'s');
assert.equal(MAX_TAGS, table.max_tags, 'the tag limit is the server\'s');
for (const c of table.tags) assert.equal(normalizeTag(c.input), c.want, `${JSON.stringify(c.input)} (${c.note || ''})`);
console.log(`artifact_tag_rules_unit: ${table.tags.length} cases ok`);
