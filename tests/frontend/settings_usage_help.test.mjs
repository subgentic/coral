// The Usage analytics row (#10698, #10705): the visible line keeps the promise ("Anonymous product events only, no prompts.") and the full exclusion is behind the row's More, out of the visible word count the Settings budget holds.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const F = await importUi('settings_fields');
const specs = Object.values(F).filter(Array.isArray).flat();
const row = specs.find(f => f && f.key === 'telemetry_enabled');
assert.ok(row, 'the Usage analytics field is in the Settings spec');
assert.equal(row.help.more, 'No prompts, transcripts or secrets are sent.', 'the More text is the full exclusion');
assert.equal(row.help.text, 'Anonymous product events only, no prompts.', 'the visible help keeps the promise, "no prompts" (the privacy check reads "Anonymous product events" there)');
console.log('settings_usage_help: ok');
