// The shared agent name (#12168): every converted site draws an agent's name through static/agent_link.js, and the pending list is the honest inventory of the rest. A converted file that stops importing and calling the
// helper fails; a pending file that has started using it must be moved to "converted" in agent_name_sites.json; the helper itself never sets innerHTML (a name is text).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), statics = join(here, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const sites = JSON.parse(readFileSync(join(here, 'agent_name_sites.json'), 'utf8'));
const problems = [];
const uses = f => { const src = readFileSync(join(statics, f), 'utf8'); return /(from|importOnce\() ?'\.\/agent_link\.js'/.test(src) && /\b(agentLink|linkAvatar)\(/.test(src); };
for (const { file, what } of sites.converted) {
    if (!existsSync(join(statics, file))) { problems.push(`${file} is listed as converted and does not exist`); continue; }
    if (!uses(file)) problems.push(`${file}: ${what} must draw an agent's name through agent_link.js (agentLink / linkAvatar), and no longer does`);
}
for (const { file } of sites.pending) {
    if (!existsSync(join(statics, file))) { problems.push(`${file} is listed as pending and does not exist: remove it`); continue; }
    if (uses(file)) problems.push(`${file} uses agent_link.js now: move it from "pending" to "converted" in agent_name_sites.json`);
}
const helper = readFileSync(join(statics, 'agent_link.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (/innerHTML|insertAdjacentHTML|outerHTML/.test(helper)) problems.push('agent_link.js sets HTML: a name is set as text only');
if (/toLowerCase\(\)\s*[;,)]\s*$/m.test(helper.split('\n').filter(l => /textContent|\.append\(/.test(l)).join('\n'))) problems.push('agent_link.js lower-cases a name it shows');
assert.deepEqual(problems, [], 'the agent name sites:\n  ' + problems.join('\n  '));
console.log(`agent_name_census: ${sites.converted.length} converted, ${sites.pending.length} pending, helper clean ok`);
