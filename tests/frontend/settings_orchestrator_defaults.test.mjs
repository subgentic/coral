// The thinking lists Settings offers for each type are the levels Coral passes to that CLI (agentmodels/thinking.go, #4969): the dashboard's copy is pinned to the Go table, so a level added there is added here (#13899). node settings_orchestrator_defaults.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const go = fs.readFileSync(path.join(here, '..', '..', 'coral-go', 'internal', 'agentmodels', 'thinking.go'), 'utf8');
const js = fs.readFileSync(path.join(here, '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'settings_fields.js'), 'utf8');
const table = go.slice(go.indexOf('var thinkingLevels'), go.indexOf('}\n', go.indexOf('var thinkingLevels')));
const goLevels = Object.fromEntries([...table.matchAll(/"(\w+)":\s*\{([^}]*)\}/g)].map(m => [m[1], [...m[2].matchAll(/"(\w+)"/g)].map(x => x[1])]));
const jsBlock = js.slice(js.indexOf('const THINKING_LEVELS = {'), js.indexOf('};', js.indexOf('const THINKING_LEVELS = {')));
const jsLevels = Object.fromEntries([...jsBlock.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map(m => [m[1], [...m[2].matchAll(/'(\w+)'/g)].map(x => x[1])]));
assert.ok(Object.keys(jsLevels).length >= 4, 'the dashboard lists the types that take levels: ' + JSON.stringify(jsLevels));
for (const [type, levels] of Object.entries(jsLevels)) assert.deepEqual(levels, goLevels[type], `${type}: the dashboard's levels are the Go table's`);
console.log(`PASS settings_orchestrator_defaults: ${Object.keys(jsLevels).join(', ')} levels match agentmodels/thinking.go`);
