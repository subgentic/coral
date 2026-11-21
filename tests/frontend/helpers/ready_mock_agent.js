'use strict';
// Real prompt recipe (#20378). Use run_cdp_suites.mjs: it builds coral, mock-agent,
// coral-board and coral-hook-* together, isolates the profile/data/socket and turns
// the Hub off. A manual server needs those same sibling tools (or CORAL_HOOK_DIR),
// MOCK_AGENT_READY=1 and a temp profile/CLAUDE_PROJECTS_DIR. A menu drawn in the pane
// alone proves nothing: SessionStart and PermissionRequest hooks supply live state.
// Use raw CDP, not agent_view_harness: its PRELOAD replaces the real live feed with
// window.__m, which is empty until add() is called. Never inject a live-row fixture
// into this recipe: wait for the server and the page to discover the launched id.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function readyMock(api) {
    const settings = await api('GET', '/api/settings');
    const original = (settings.data.settings || settings.data).cli_path_claude;
    assert.match(path.basename(original || ''), /^mock-agent(?:\.exe)?$/, 'runner must configure its own mock-agent, never a real CLI');
    for (const tool of ['coral-hook-session-start', 'coral-hook-agentic-state']) {
        assert.ok(fs.existsSync(path.join(path.dirname(original), tool)), `build ${tool} next to mock-agent (or use the runner)`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-ready-prompt-'));
    const cli = path.join(dir, 'claude');
    const quote = x => "'" + x.replace(/'/g, "'\\''") + "'";
    fs.writeFileSync(cli, '#!/bin/sh\nMOCK_AGENT_READY=1 exec ' + quote(original) + ' "$@"\n', { mode: 0o755 });
    const agents = [];
    try {
        assert.equal((await api('PUT', '/api/settings', { cli_path_claude: cli })).status, 200);
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
    return {
        async launch(displayName) {
            const r = await api('POST', '/api/sessions/launch', { agent_type: 'claude', working_dir: dir, display_name: displayName });
            assert.equal(r.status, 200, 'mock launch: ' + JSON.stringify(r.data));
            agents.push(r.data);
            return r.data;
        },
        async stop() {
            for (const a of agents) await api('POST', `/api/sessions/live/${encodeURIComponent(a.session_name)}/kill`, { agent_type: 'claude', session_id: a.session_id });
            await api('PUT', '/api/settings', { cli_path_claude: original });
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
module.exports = { readyMock };
