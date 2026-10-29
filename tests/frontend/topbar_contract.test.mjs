// The top-bar contract Hub pages copy (#11106): every value TOPBAR_CONTRACT.md lists (its `contract:` lines) is still in the stylesheet it names, so the document and the CSS cannot drift apart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.join(here, '../../coral-go/pkg/frontend');
const doc = fs.readFileSync(path.join(frontend, 'TOPBAR_CONTRACT.md'), 'utf8');
const lines = [...doc.matchAll(/<!-- contract: ([^|]+?) \| (.+?) -->/g)].map(m => [m[1].trim(), m[2].trim()]).filter(([f]) => f.endsWith('.css'));
assert.ok(lines.length >= 12, 'the contract lists its values');
const bad = lines.filter(([file, text]) => !fs.readFileSync(path.join(frontend, 'static', file), 'utf8').includes(text));
assert.deepEqual(bad, [], 'the contract names values the stylesheets no longer have: change the CSS and TOPBAR_CONTRACT.md together');
console.log(`topbar_contract: ok (${lines.length} values)`);
