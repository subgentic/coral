// The Usage analytics row says it applies at once (#10698, #10671's SHOULD): the sentence is behind the row's More, out of the visible word count the Settings budget holds, and the visible help stays the one line.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const F = await importUi('settings_fields');
const specs = Object.values(F).filter(Array.isArray).flat();
const row = specs.find(f => f && f.key === 'telemetry_enabled');
assert.ok(row, 'the Usage analytics field is in the Settings spec');
assert.match(row.help.more, /Applies immediately\.$/, 'the More text says it applies immediately');
assert.match(row.help.more, /No prompts, transcripts or secrets are sent\./, 'and what is never sent');
assert.equal(row.help.text, 'Anonymous product events only.', 'the visible help is the promise in one line: the privacy check reads "Anonymous product events" there');
console.log('settings_usage_help: ok');
