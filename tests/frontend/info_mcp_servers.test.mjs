// info_dialog.js (#9769): the Info dialog's MCP servers: the lines it shows for what the route answers.
//   node info_mcp_servers.test.mjs
import assert from 'node:assert';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

process.env.CORAL_TELEMETRY_DISABLED = '1'; // a jsdom page and a faked fetch: no Coral starts; the opt-out stays on for the telemetry census

installDom({ mode: 'local' });
const dlg = await importUi('info_dialog');

assert.deepEqual(dlg.mcpLines(null), [], 'no answer: no row');
assert.deepEqual(dlg.mcpLines({ supported: false, servers: [] }), [], 'a CLI Coral does not read: no row');
assert.deepEqual(dlg.mcpLines({ supported: true, servers: [] }), ['None configured']);
assert.deepEqual(dlg.mcpLines({ supported: true, servers: [{ name: 'github', transport: 'http', scope: 'user' }, { name: 'files', transport: 'stdio', scope: 'project' }] }),
    ['github: http, user', 'files: stdio, project']);
assert.deepEqual(dlg.mcpLines({ supported: true, truncated: true, servers: [{ name: 'a', transport: 'stdio', scope: 'user' }] }), ['a: stdio, user', 'and more']);
assert.deepEqual(dlg.mcpLines({ supported: true, servers: 'x' }), [], 'a malformed answer shows nothing');
console.log('info_mcp_servers: ok');
