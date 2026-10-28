// The words of Settings > Agents > CLI paths > Verify (#10083): a CLI the person does not use is "Not installed" in a neutral colour, not a red failure; a path Coral refuses says why and what to do.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { cliVerifyWords } = await import(pathToFileURL(path.resolve(here, '../../coral-go/pkg/frontend/static/cli_verify_words.js')).href);

// found: the version, green
assert.deepEqual(cliVerifyWords({ ok: true, data: { found: true, version: '2.1.0' }, typed: '', type: 'claude' }), { text: '2.1.0', cls: 'cli-verify-ok', hint: '' });
assert.equal(cliVerifyWords({ ok: true, data: { found: true }, typed: '', type: 'codex' }).text, 'Found');

// not found while the field is empty (or a bare program name): the person never set a path, so it is not an error
for (const typed of ['', '  ', 'codex']) {
    const r = cliVerifyWords({ ok: true, data: { found: false }, typed, type: 'codex' });
    assert.deepEqual(r, { text: 'Not installed', cls: 'cli-verify-none', hint: '' }, `typed ${JSON.stringify(typed)}`);
}
// not found at a path the person typed: that is a mistake worth a red word, with the way out
const nf = cliVerifyWords({ ok: true, data: { found: false }, typed: '/opt/tools/codex', type: 'codex' });
assert.equal(nf.text, 'Not found'); assert.equal(nf.cls, 'cli-verify-fail'); assert.match(nf.hint, /nothing at that path/i); assert.match(nf.hint, /empty/i);

// refused: the reason, and the fix
const refused = (error, type = 'claude', typed = '/tmp/bt/bin/mock-agent') => cliVerifyWords({ ok: false, status: 400, data: { error }, typed, type });
let r = refused('binary is in a temporary folder');
assert.equal(r.text, 'Not allowed'); assert.equal(r.cls, 'cli-verify-fail');
assert.match(r.hint, /temporary folder/i); assert.match(r.hint, /agent can write/i); assert.match(r.hint, /empty the field to use PATH/i);
assert.match(refused("binary is in Coral's data folder").hint, /data folder/i);
assert.match(refused("binary is in an agent's working folder").hint, /working folder/i);
assert.match(refused('binary must be an absolute path').hint, /full path/i);
assert.match(refused('binary must be a configured CLI path or a path to claude').hint, /claude/);
r = refused('binary must be a known CLI (agy, claude, codex, pi) or the path of one', 'codex', 'rm');
assert.match(r.hint, /codex/i);
// an operator-only refusal and an answer this does not know: still a reason and the fix, never a bare word
assert.match(cliVerifyWords({ ok: false, status: 403, data: { error: 'only the Operator can check a CLI by its path' }, typed: '/x/codex', type: 'codex' }).hint, /Operator/);
r = refused('something new');
assert.match(r.hint, /something new/i); assert.match(r.hint, /empty the field to use PATH/i);
r = cliVerifyWords({ ok: false, status: 500, data: null, typed: '/x/claude', type: 'claude' });
assert.equal(r.text, 'Not allowed'); assert.ok(r.hint.length > 20, 'a refusal with no body still says what to do');
// the server could not be reached
assert.deepEqual(cliVerifyWords({ error: true }), { text: 'Error', cls: 'cli-verify-fail', hint: 'Coral could not be reached. Try again.' });
console.log('cli_verify_words: ok');
