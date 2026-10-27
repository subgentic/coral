// The Export dialog's agent checkboxes (#9231): an agent's id is the checkbox's value, escaped once. It was escaped twice, so an id with an & (or a quote) was read back as another name and
// that agent's chat history was exported under it. The role is text, never markup. Run: node board_export_agents.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { agentCheckboxHtml } = await importUi('board_export');

const read = html => { const host = document.createElement('div'); host.innerHTML = html; const cb = host.querySelector('.export-agent-cb'); return { value: cb.value, role: cb.dataset.role, label: host.querySelector('span').textContent, spans: host.querySelectorAll('span').length, inputs: host.querySelectorAll('input').length }; };

for (const id of ['Backend Dev', 'R&D Bot', 'Q&A "Lead"', "It's <b>me</b>", 'a&amp;b']) {
    const got = read(agentCheckboxHtml({ subscriber_id: id, job_title: '' }));
    assert.equal(got.value, id, `the checkbox value is the id as it is: ${id}`);
    assert.equal(got.role, id);
    assert.equal(got.label, id, 'shown as text');
    assert.equal(got.spans, 1);
    assert.equal(got.inputs, 1, 'nothing in an id becomes markup');
}
const titled = read(agentCheckboxHtml({ subscriber_id: 'qa-1', job_title: 'Q&A <i>Engineer</i>' }));
assert.equal(titled.value, 'qa-1');
assert.equal(titled.role, 'Q&A <i>Engineer</i>');
assert.equal(titled.label, 'Q&A <i>Engineer</i>');
console.log('board_export_agents: all checks passed');
