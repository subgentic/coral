/* Moved out of modals.js as it was (#4684): The launches that start from a board or a folder group: Add agent (to a board or standalone), the Terminal, and the default agent. No behaviour change. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { splitKey, isHub, normServer, LOCAL_SERVER, keyLabel, teamFetch, pickTeamFolder } from './server_base.js';
import { serverLabel, bareBoardName } from './launch_server.js';
const { launch } = await importOnce('./launch_state.js');
const { _effectiveServer, _loadServerSettings, _settingsFor } = await importOnce('./launch_models.js');
const { defaultPermissionMode, _getPermissionFlagsForAgentMode } = await importOnce('./permission_flags.js');
const { _launchBlocked, _launchOn, _onServerSuffix, _refreshAfterLaunch } = await importOnce('./launch_core.js');

// ── Add Agent to Board ───────────────────────────────────────────────────
// Launches started from inside a board / folder group inherit that group's
// server (the key is "@server/name" for remotes) and cannot be redirected: the
// working directory shown belongs to that server.
// Add agent is New Agent's own dialog with the team (or the folder) preset (#7778, launch_dialog.js showAddAgentFlow): persona, Next, the agent with its permissions.

/** The team's home folder (#10815) from its own record, '' when it has none or cannot be read (a team of a computer that is away, a board that is not a launched team). */
async function _teamHomeFolder(boardName) {
    try {
        const r = await teamFetch(boardName, n => `/api/teams/detail/${encodeURIComponent(n)}`);
        const d = r.ok ? await r.json() : null;
        return d && typeof d.working_dir === 'string' ? d.working_dir : '';
    } catch { return ''; }
}

export async function showAddAgentToBoard(boardName, workDir) {
    const { showAddAgentFlow } = await importOnce('./launch_dialog.js');
    workDir = pickTeamFolder(await _teamHomeFolder(boardName), [{ working_directory: workDir }]); // the home folder first, then the folder the row offered (a session that has one) (#11083)
    showAddAgentFlow({ board: boardName, workDir, server: splitKey(boardName).server });
}

// ── Launch Terminal to Board ─────────────────────────────────────────────

export async function launchTerminalToBoard(boardName, workDir) {
    workDir = pickTeamFolder(await _teamHomeFolder(boardName), [{ working_directory: workDir }]); // as Add agent (#11083)
    const server = _effectiveServer(splitKey(boardName).server);
    if (_launchBlocked(server)) return;
    const board = bareBoardName(boardName);
    try {
        const result = await _launchOn(server, "/api/sessions/launch", {
            working_dir: workDir,
            agent_type: "terminal",
            display_name: "Terminal",
            board_id: board, // joins the board (#3536)
            board_name: board,
        });
        if (result) {
            showToast(`Launched Terminal on ${keyLabel(boardName)}${_onServerSuffix(server)}`);
            _refreshAfterLaunch(server, { sessionName: result.session_name, sessionId: result.session_id });
        }
    } catch (e) {
        showToast("Could not start the terminal. Check that the folder exists, then try again.", "error");
    }
}

/** What a folder's menu launched (Add Agent, Add Terminal) is opened, and the folder is open in the list: the person asked for it, so it is not left as a row to find (#10077). Local only, as New agent's Launch is. */
async function openFolderLaunch(server, result, type, workDir) {
    if (normServer(server) !== LOCAL_SERVER) return;
    try {
        const { _openLaunched } = await importOnce('./launch_dialog.js');
        await _openLaunched(result, type);
        const { pinKeyForPath } = await importOnce('./pinned_folders.js');
        const key = pinKeyForPath(workDir);
        if (key) (await importOnce('./group_collapse.js')).expandGroup(key);
    } catch { /* the toast and the list row are still there */ }
}

// ── Standalone Agent Launch (no board) ────────────────────────────────────

export async function launchDefaultAgent(workDir, server) {
    server = _effectiveServer(server);
    if (_launchBlocked(server)) return;
    let s = _settingsFor(server);
    if (server !== LOCAL_SERVER) {
        // Defaults (agent type, permission mode) are the remote's own; if they
        // cannot be read the remote is not reachable, so launch nothing.
        try { s = await _loadServerSettings(server, { fresh: true }); } catch (e) {
            showToast(`${serverLabel(server, state.servers)}: ${e.message || 'unreachable'}`, true);
            return;
        }
    }
    const agentType = s.default_agent_type || 'claude';
    const permFlag = _getPermissionFlagsForAgentMode(agentType, defaultPermissionMode(s, agentType));
    const flags = permFlag ? permFlag.split(/\s+/) : [];

    const payload = {
        working_dir: workDir,
        agent_type: agentType,
        flags,
    };

    try {
        const result = await _launchOn(server, '/api/sessions/launch', payload, agentType);
        if (result) {
            showToast(`Launched ${agentType} agent${_onServerSuffix(server)}`);
            _refreshAfterLaunch(server, { sessionName: result.session_name, sessionId: result.session_id });
            await openFolderLaunch(server, result, agentType, workDir); // the person lands in the new chat, as New agent's Launch does (#10077)
        }
    } catch (e) {
        showToast('Could not start the agent. Check that the folder exists and that the agent is installed, then try again.', 'error');
    }
}

export async function showAddStandaloneAgent(workDir, server) {
    const { showAddAgentFlow } = await importOnce('./launch_dialog.js');
    showAddAgentFlow({ board: '', workDir, server }); // a folder group's agent: no team
}

/**
 * Server of the folder group whose directory is `workDir`, for callers that
 * only know the path. Falls back to local when no live session uses it; refuses
 * (returns null) when the same path is used on several servers, because
 * guessing could launch on the wrong machine.
 */
function _serverForWorkDir(workDir) {
    if (!isHub()) return LOCAL_SERVER;
    const servers = new Set((state.liveSessions || [])
        .filter(s => s.working_directory === workDir)
        .map(s => normServer(s.server)));
    if (servers.size === 0) return LOCAL_SERVER;
    return servers.size === 1 ? [...servers][0] : null;
}

export async function launchStandaloneTerminal(workDir, server) {
    if (server === undefined) {
        server = _serverForWorkDir(workDir);
        if (server === null) {
            showToast('This directory is used on more than one server; launch the terminal from that server\'s group.', true);
            return;
        }
    }
    server = _effectiveServer(server);
    if (_launchBlocked(server)) return;
    try {
        const result = await _launchOn(server, '/api/sessions/launch', {
            working_dir: workDir,
            agent_type: 'terminal',
            display_name: 'Terminal',
        });
        if (result) {
            showToast(`Launched Terminal${_onServerSuffix(server)}`);
            _refreshAfterLaunch(server, { sessionName: result.session_name, sessionId: result.session_id });
            await openFolderLaunch(server, result, 'terminal', workDir);
        }
    } catch (e) {
        showToast('Could not start the terminal. Check that the folder exists, then try again.', 'error');
    }
}
