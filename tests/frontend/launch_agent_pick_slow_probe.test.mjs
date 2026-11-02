// #12169 (b), the Hermes tester: with only Hermes installed, New agent stayed on Claude ("claude CLI was not found", Launch disabled). The CLI check answers after running "<cli> --version", which Hermes
// (a Python program) takes seconds to do, longer than the 1.5 s the agent choice waits for an answer, so Hermes was "unknown" and no installed agent was found to start on. When Claude is missing and nothing
// was ever chosen, the choice now waits longer for the agents that have not answered, and starts on the first that is installed.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });

const answers = { claude: { found: false, ms: 0 }, codex: { found: false, ms: 0 }, agy: { found: false, ms: 0 }, pi: { found: false, ms: 0 }, opencode: { found: false, ms: 0 }, hermes: { found: true, ms: 2600 } };
globalThis.fetch = window.fetch = async url => {
    const m = /\/api\/system\/cli-check\?type=([a-z]+)/.exec(String(url));
    const a = m && answers[m[1]];
    if (!a) return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
    if (a.ms) await new Promise(r => setTimeout(r, a.ms));
    return { ok: true, status: 200, json: async () => ({ found: a.found, agent_type: m[1] }), headers: new Map() };
};
const { buildAgentPick } = await importUi('launch_agent_pick');
const { buildProviderCards } = await importUi('launch_provider_cards');

const make = (id = 'g') => {
    const form = document.createElement('div');
    form.innerHTML = '<select class="acf-agent-type"><option value="claude">Claude</option><option value="codex">Codex</option><option value="agy">Antigravity</option><option value="pi">Pi</option><option value="opencode">OpenCode</option><option value="hermes">Hermes</option></select>';
    const group = document.createElement('div'); group.id = id;
    document.body.append(form, group);
    return { form, group, select: form.querySelector('.acf-agent-type') };
};

// A slow answer from the only installed agent: the choice moves to it.
let t = make();
await buildAgentPick({ group: t.group, form: t.form, server: 'local', implicitDefault: true });
assert.equal(t.select.value, 'hermes', 'Claude is missing and Hermes (slow to answer) is the only one installed: the form starts on Hermes');

// Nothing is installed: it stays where it was (and does not wait for ever).
for (const k of Object.keys(answers)) answers[k] = { found: false, ms: k === 'hermes' ? 2600 : 0 };
t = make();
await buildAgentPick({ group: t.group, form: t.form, server: 'local', implicitDefault: true });
assert.equal(t.select.value, 'claude', 'nothing installed: it stays on Claude');

// A person's own default (implicitDefault false) is never moved.
answers.hermes = { found: true, ms: 2600 };
t = make();
await buildAgentPick({ group: t.group, form: t.form, server: 'local', implicitDefault: false });
assert.equal(t.select.value, 'claude', 'a chosen default stays');

// Claude installed: no wait, no move.
answers.claude = { found: true, ms: 0 };
t = make();
const started = Date.now();
await buildAgentPick({ group: t.group, form: t.form, server: 'local', implicitDefault: true });
assert.equal(t.select.value, 'claude');
assert.ok(Date.now() - started < 2200, 'Claude is there: the choice is drawn without waiting for the slow one');

// New agent's own cards (launch_provider_cards.js) have the same rule.
for (const k of Object.keys(answers)) answers[k] = { found: false, ms: k === 'hermes' ? 2600 : 0 };
answers.hermes = { found: true, ms: 2600 };
t = make('launch-agent-pick');
await buildProviderCards({ group: t.group, form: t.form, server: 'local', implicitDefault: true });
assert.equal(t.select.value, 'hermes', 'New agent\'s cards: Claude missing and Hermes (slow to answer) the only one installed: it starts on Hermes');
t = make('launch-agent-pick-2');
await buildProviderCards({ group: t.group, form: t.form, server: 'local', implicitDefault: false });
assert.equal(t.select.value, 'claude', 'New agent\'s cards: a chosen default stays');
console.log('launch_agent_pick_slow_probe: ok');
process.exit(0);
