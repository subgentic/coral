// #11603 (coral-hub's push request): on the Cloud Hub the dashboard unregisters every service worker of the origin on each load (a caching worker could leak one account's data to the next person), which would
// kill the Hub's push-only worker. Exactly one registration is exempt: the one whose scope is exactly '<origin>/push/'. Every other registration is removed, whatever its scope (a look-alike scope, a longer
// path, the root, another origin's), and a local Coral still registers its own worker. static/sw_register.js is run as the page runs it, with a fake navigator.serviceWorker.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend/static/sw_register.js'), 'utf8');
const ORIGIN = 'https://app.example.test';

const PUSH = `${ORIGIN}/push/sw.js`, w = scriptURL => ({ scriptURL });
// a registration: its scope and the script of its active worker (or of a waiting or installing one: { waiting: url })
const reg = (scope, script = PUSH) => ({ scope, script });
async function run(mode, specs) {
    const removed = [], registered = [];
    const regs = specs.map(sp => { const spec = typeof sp === 'string' ? reg(sp) : sp, kind = spec.kind || 'active', r = { scope: spec.scope, active: null, waiting: null, installing: null, unregister() { removed.push(spec.scope + (spec.script === PUSH ? '' : ' [' + String(spec.script || 'no worker').replace(ORIGIN, '') + ']')); return Promise.resolve(true); } }; if (spec.script) r[kind] = w(spec.script); return r; });
    const ctx = {
        document: { getElementById: () => ({ textContent: JSON.stringify({ mode }) }) },
        navigator: { serviceWorker: { getRegistrations: () => Promise.resolve(regs), register: (url, opts) => { registered.push([url, opts.scope]); return Promise.resolve(); } } },
        location: { origin: ORIGIN },
    };
    vm.runInNewContext(src, ctx);
    await new Promise(r => setTimeout(r, 20)); // the promise chain settles
    return { removed, registered };
}

const cloud = await run('cloud', [`${ORIGIN}/push/`, `${ORIGIN}/`, `${ORIGIN}/push`, `${ORIGIN}/push/inner/`, `${ORIGIN}/pushy/`, `${ORIGIN}/static/`, 'https://other.example.test/push/']);
assert.ok(!cloud.removed.includes(`${ORIGIN}/push/`), `the /push/ worker survives a load: ${JSON.stringify(cloud.removed)}`);
assert.deepEqual(cloud.removed.sort(), [`${ORIGIN}/`, `${ORIGIN}/push`, `${ORIGIN}/push/inner/`, `${ORIGIN}/pushy/`, `${ORIGIN}/static/`, 'https://other.example.test/push/'].sort(), 'every other registration is removed, look-alikes included');
assert.deepEqual(cloud.registered, [], 'the Hub registers no worker of its own');
// Security's second condition: the script too. Any other worker claiming /push/ is removed, active, waiting or installing; one with no worker at all is not the push worker either.
const other = await run('cloud', [{ scope: `${ORIGIN}/push/`, script: `${ORIGIN}/static/sw.js` }, { scope: `${ORIGIN}/push/`, script: `${ORIGIN}/push/other.js`, kind: 'waiting' }, { scope: `${ORIGIN}/push/`, script: `${ORIGIN}/push/sw.js?x=1`, kind: 'installing' }, { scope: `${ORIGIN}/push/`, script: 'https://other.example.test/push/sw.js' }, { scope: `${ORIGIN}/push/` , script: null }]);
assert.equal(other.removed.length, 5, `any other worker claiming /push/ is removed: ${JSON.stringify(other.removed)}`);
for (const kind of ['active', 'waiting', 'installing']) assert.deepEqual((await run('cloud', [{ scope: `${ORIGIN}/push/`, script: PUSH, kind }])).removed, [], `the push worker survives as the ${kind} worker`);
const mixed = await run('cloud', [{ scope: `${ORIGIN}/push/`, script: PUSH }]);
assert.deepEqual(mixed.removed, [], 'the exact scope and script survive');
const only = await run('cloud', [`${ORIGIN}/push/`]);
assert.deepEqual(only.removed, [], 'a Hub with only the push worker removes nothing');
const local = await run('local', [`${ORIGIN}/`]);
assert.deepEqual([local.removed, local.registered], [[], [['/static/sw.js', '/']]], 'a local Coral registers its own worker and removes none');
console.log('sw_register_push_exempt: ok (only the exact /push/ scope survives on the Hub)');
