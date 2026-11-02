// #12464: the launch dialog and Restart with changes build the agent's permission flags from PERM_FLAGS and _getPermissionFlagsForAgentMode (permission_flags.js). Hermes had no entry, so Bypass permissions sent no --yolo
// and the agent ran in Default while the dialog promised Bypass. The page says what the server says (internal/agent PermissionFlagsForAgent: Hermes gets --yolo for Bypass only). node hermes_permission_flags.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const m = await importUi('permission_flags');
const flags = (mode) => m._getPermissionFlagsForAgentMode('hermes', mode);
assert.equal(flags('bypassPermissions'), '--yolo', 'Bypass is --yolo');
for (const mode of ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk']) assert.equal(flags(mode), '', `${mode} sends no flag: Hermes asks before a dangerous command, its own menu`);
assert.equal(m._normalizePermFlagsForAgent('', 'hermes', 'bypassPermissions'), '--yolo', 'a launch with Bypass carries --yolo');
assert.equal(m._normalizePermFlagsForAgent('--yolo', 'hermes', 'default'), '', 'a restart changed to Default drops the --yolo it had');
assert.equal(m._normalizePermFlagsForAgent('--model x --dangerously-skip-permissions', 'hermes', 'bypassPermissions'), '--model x --yolo', "another CLI's flag is not Hermes's");
assert.equal(m._permissionModeFromFlags('--yolo'), 'bypassPermissions', 'and the page reads --yolo back as Bypass');
console.log('hermes_permission_flags: ok');
