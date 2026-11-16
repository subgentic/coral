// A model id as the list names it (#10266, Mobile pass 18): every Claude family is named the same way, so fable-5-1 is "Fable 5.1" like claude-opus-5-5 is "Opus 5.5" (it was shown as the bare id).
import assert from 'node:assert/strict';
import { modelName, modelLabel } from '../../coral-go/pkg/frontend/static/model_labels.js';

for (const [id, name] of [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-4-1-20250805', 'Opus 4.1'], ['claude-3-5-sonnet', 'Sonnet 3.5'], ['claude-5-1-fable', 'Fable 5.1']]) {
    assert.equal(modelName('claude', id, 'local'), name, id);
}
assert.equal(modelLabel('claude', 'claude-fable-5-1', 'local'), 'Claude · Fable 5.1');
assert.equal(modelName('claude', 'some-new-model', 'local'), 'some-new-model', 'an id nothing here knows is shown as it is');

// The Agents row and the chat's chip say the same model and level because both take them from model_labels.js, never from the fields (#17597, QA5 on #17427):
// a row or a chip that built its own level or name text could drift from the other.
import fs from 'node:fs';
const dir = new URL('../../coral-go/pkg/frontend/static/', import.meta.url);
const strip = f => fs.readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const f of ['session_rows.js', 'model_chip.js']) {
    const src = strip(f);
    assert.ok(/\bsessionLevel\(/.test(src), f + ' reads the level through sessionLevel');
    assert.ok(/\bmodel(Name|Label)\(/.test(src), f + ' names the model through modelName / modelLabel');
}
console.log('model_labels: ok');
