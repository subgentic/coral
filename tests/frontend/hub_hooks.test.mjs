// The Hub-facing hooks (#12124, Goal #196): every element Coral Hub's scripts use carries data-coral-hook="<hook>" where Coral builds it, next to the older class or id they use today; the ids, attributes, storage key, words
// and ready parts they read are still in the page's source. hub_hooks.json is the Hub's own list (hub-selectors-and-wording.txt version 2) as a manifest; a hook that disappears or is renamed fails here, and a rename needs
// a "For Coral Hub" line in the release notes. Static: reads the page's templates and scripts, runs nothing.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), frontend = join(here, '..', '..', 'coral-go', 'pkg', 'frontend');
const manifest = JSON.parse(readFileSync(join(here, 'hub_hooks.json'), 'utf8'));
const read = f => readFileSync(join(frontend, f), 'utf8');
const walk = d => readdirSync(join(frontend, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const all = [...walk('static'), ...walk('templates')].filter(f => /\.(js|css|html)$/.test(f) && !f.includes('agent_docs')).map(read).join('\n');
const problems = [];
const need = (ok, what) => { if (!ok) problems.push(what); };

for (const { hook, legacy, files } of manifest.hooks) {
    const forms = [`data-coral-hook="${hook}"`, `coralHook = '${hook}'`, `'data-coral-hook': '${hook}'`, `setAttribute('data-coral-hook', '${hook}')`];
    for (const f of files) {
        const src = read(f);
        need(forms.some(x => src.includes(x)), `${f}: the hook "${hook}" is gone (data-coral-hook, #12124): Coral Hub's scripts use it`);
        need(src.includes(legacy), `${f}: "${legacy}", which the Hub's scripts still use for "${hook}", is gone`);
    }
}
for (const { what, token, files } of manifest.attributes) for (const f of files) need(read(f).includes(token), `${f}: ${what} (token ${token}) is gone`);
for (const { key, files } of manifest.storageKeys) for (const f of files) need(read(f).includes(key), `${f}: the storage key "${key}" is gone`);
for (const w of manifest.wording) need(all.includes(w), `the word "${w}", which the Hub's scripts read, is no longer in the page`);
const ready = read('static/ready.js');
for (const part of manifest.readyParts) need(new RegExp(`\\b${part}\\b`).test(ready), `window.__coralReady: the part "${part}" is gone`);
// a hook is named once: two elements of different kinds do not share one name in this manifest
const names = manifest.hooks.map(h => h.hook);
need(new Set(names).size === names.length, 'a hook is listed twice in hub_hooks.json');
// every data-coral-hook in the page is in the manifest (a new one is a deliberate, listed one)
const used = new Set([...all.matchAll(/data-coral-hook="([a-z0-9-]+)"|coralHook = '([a-z0-9-]+)'|'data-coral-hook': '([a-z0-9-]+)'|setAttribute\('data-coral-hook', '([a-z0-9-]+)'\)/g)].map(m => m[1] || m[2] || m[3] || m[4]));
for (const u of used) need(names.includes(u), `data-coral-hook="${u}" is in the page and not in hub_hooks.json: list it, so a later rename is caught`);

assert.deepEqual(problems, [], 'the Hub-facing hooks:\n  ' + problems.join('\n  '));
console.log(`hub_hooks: ${names.length} hooks, ${manifest.attributes.length} attributes, ${manifest.wording.length} words, ${manifest.readyParts.length} ready parts ok`);
