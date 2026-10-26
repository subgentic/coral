/* The launch flow's shared state (#3836): one object instead of module-level lets, so the agent config form, the team form, the
 * model lists and the other launch pieces can live in modules of their own and read and set the same values. */
import { LOCAL_SERVER } from './server_base.js';

export const launch = {
    // Which launch mode is active: null (the chooser), 'agent' or 'terminal'.
    mode: null,
    existingTeamBoardNames: new Set(),
    teamAgentModalRow: null,
    teamAddress: false, // the team's Machine is "Another computer's address..." (#7407)
    // A launch always runs on exactly one server (multi-server hub, spec section 5). `server` is the Server dropdown of the
    // launch modal; Add agent (addTo, below) runs on the server of the team or folder it starts from.
    // With hub mode off both stay "local" and nothing touches /api/remote/*.
    server: LOCAL_SERVER,
    serverLocked: false,
    // Add agent (#7778): New Agent's own dialog with the folder and the team preset: { board: the team's key ('' for a folder's agent with no team), workDir, skipFolder } while it is open, else null.
    addTo: null,
    teamAgentCounter: 0,
    skipDefaultTeamAgents: false,
};
