/* The agent's Files viewer sources: its changed files, the repository tree and its artifacts. The artifacts are the team page's Artifacts table scoped to this agent (team_artifacts_page.js), drawn in the dock's panel;
 * the team's own artifacts and knowledge are the team page's (#7457, #7622). */
import { state } from './state.js';
import { mountExplorer, showExplorer, syncExplorerSession } from './file_explorer.js';
import { sessionTeamKey, sessionServer } from './server_base.js';
import { importOnce } from './import_once.js';

let source = 'files';
let team = null;
let sessionID = null;
const panels = { files: 'agentic-panel-files', browse: 'agentic-panel-browse', artifacts: 'agentic-panel-artifacts' };

function currentTeam() {
    return state.currentSession?.type === 'live' ? sessionTeamKey(state.currentSession) || null : null;
}

/** The agent's artifacts are the team page's Artifacts table, scoped to this agent and drawn in the dock's panel (its document opens as a sheet over the panel). */
async function showAgentArtifacts() {
    const host = document.getElementById('agentic-panel-artifacts-view'), session = state.currentSession;
    if (!host || !sessionID || !session) return;
    const { showArtifacts } = await importOnce('./team_artifacts_page.js');
    if (source !== 'artifacts' || sessionID !== state.currentSession?.session_id) return; // another tab or agent was chosen while the module loaded
    const name = session.display_name || session.name || 'Selected agent';
    showArtifacts(host, team || '', { detailHost: document.getElementById('agentic-detail-pane') }, { session: sessionID, server: sessionServer(session), standalone: !team, name });
}

function activate() {
    if (source === 'browse') showExplorer();
    else if (source === 'artifacts') showAgentArtifacts();
}

/** Called by switchAgenticTab: each source is a top-level sidebar tab. */
export function selectFilesSource(next) {
    if (!(next in panels) || source === next) return;
    source = next; activate();
}

export function initFilesSourcePicker(onFilePreview) {
    mountExplorer(onFilePreview);
    syncFilesSourceTeam(); activate();
}

export function syncFilesSourceTeam() {
    const next = currentTeam();
    const nextSession = state.currentSession?.type === 'live' ? state.currentSession.session_id : null;
    const changed = next !== team || nextSession !== sessionID;
    syncExplorerSession();
    if (!changed) return;
    team = next; sessionID = nextSession;
    activate();
}
