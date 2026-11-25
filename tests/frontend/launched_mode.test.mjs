// The Mode a team member shows is what launches (#6412, #6425): an explicit mode (the member's own, else the team's) is applied and capabilities only narrow it for Codex and Antigravity;
// with no explicit mode the capabilities decide; Claude keeps the lists and the mode apart. preset_enforcement.js launchedMode mirrors internal/agent/permission_narrow.go. node launched_mode.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const { launchedMode } = await importUi('preset_enforcement');
const four = { allow: ['file_read', 'file_write', 'shell', 'git_write'] };
const readOnly = { allow: ['file_read'] };
const t = (type, mode, caps) => launchedMode(type, mode, caps);

// Codex: an explicit mode stands, capabilities only narrow it
assert.deepEqual(t('codex', 'plan', four), { narrowed: false }, 'Plan + four chips: Plan stands (read-only)');
assert.deepEqual(t('codex', 'auto', four), { narrowed: false }, 'Auto + four chips: shell restricts nothing');
assert.deepEqual(t('codex', 'bypassPermissions', four), { narrowed: false, warn: true }, 'Bypass + four chips: no sandbox, said as a warning');
assert.deepEqual(t('codex', 'bypassPermissions', null), { narrowed: false, warn: true }, 'Bypass with none');
assert.deepEqual(t('codex', 'bypassPermissions', readOnly), { narrowed: true, text: 'Read-only sandbox' }, 'Bypass + read-only chips: read-only');
assert.deepEqual(t('codex', 'auto', readOnly), { narrowed: true, text: 'Read-only sandbox' }, 'Auto + read-only chips: read-only');
assert.deepEqual(t('codex', 'plan', readOnly), { narrowed: false }, 'Plan is already read-only');
assert.deepEqual(t('codex', 'auto', { allow: ['file_read', 'file_write'] }), { narrowed: false }, 'Auto + Read and Write: chips narrow, they never make Auto ask (#21335)');
assert.deepEqual(t('codex', 'acceptEdits', null), { narrowed: false }, 'a mode with no chips');
// Codex: no explicit mode, the chips decide
assert.deepEqual(t('codex', 'default', four), { narrowed: false }, 'Default is Auto for Codex (#21335): four chips are Auto');
assert.deepEqual(t('codex', 'default', readOnly), { narrowed: true, text: 'Read-only sandbox' });
assert.deepEqual(t('codex', 'default', null), { narrowed: false });
assert.deepEqual(t('codex', '', { allow: ['file_read', 'file_write'] }), { narrowed: false }, 'Default is Auto (#21335): Read and Write do not make it ask');
// the network wording follows the pair: only workspace-write that never asks has the network on (Security's #7503)
assert.deepEqual(t('codex', 'default', { allow: ['shell'] }), { narrowed: false }, 'Shell with no Deny is Auto (#21335)');
assert.deepEqual(t('codex', 'default', { allow: ['shell'], deny: ['web_access'] }), { narrowed: false }, 'Shell with a Deny: Default is Auto, so it does not ask (#21335)');
// Claude: the mode only
assert.deepEqual(t('claude', 'plan', four), { narrowed: false });
assert.deepEqual(t('claude', 'default', four), { narrowed: false });
// Antigravity: the mode's rank, narrowed by the chips'
assert.deepEqual(t('agy', 'auto', { allow: ['file_read'] }), { narrowed: true, text: 'Plan' }, 'Auto + read-only chips is plan');
assert.deepEqual(t('agy', 'auto', { allow: ['shell', 'file_write'] }), { narrowed: false }, 'Auto + Shell and Write: Auto stands, the chips never widen it to skip permissions, and no Bypass warning (#14772)');
assert.deepEqual(t('agy', 'auto', null), { narrowed: false }, 'Auto alone is not a Bypass: no warning (#14772)');
assert.deepEqual(t('agy', 'bypassPermissions', null), { narrowed: false, warn: true }, 'Bypass warns');
assert.deepEqual(t('agy', 'bypassPermissions', { allow: ['shell', 'file_write'] }), { narrowed: false, warn: true }, 'Bypass + Shell and Write: skip permissions');
assert.deepEqual(t('agy', 'bypassPermissions', { allow: ['file_read'] }), { narrowed: true, text: 'Plan' }, 'the chips still narrow Bypass');
assert.deepEqual(t('agy', 'auto', { allow: ['file_read', 'file_write'] }), { narrowed: true, text: 'Accepts edits' }, 'Auto + file chips: accept edits narrows it');
assert.deepEqual(t('agy', 'plan', { allow: ['shell', 'file_write'] }), { narrowed: false }, 'Plan stands');
assert.deepEqual(t('agy', 'default', { allow: ['shell', 'file_write'] }), { narrowed: true, text: 'Skips permission prompts', warn: true }, 'no mode: the chips decide');
assert.deepEqual(t('agy', 'default', null), { narrowed: false });
console.log('PASS launched_mode');
