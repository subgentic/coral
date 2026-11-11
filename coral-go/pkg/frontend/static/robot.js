/* The robot on the agent page (#15152): "Copy for an agent" in the header's action slot, with the open agent's name and where in the docs to read (sessions). Loaded when an agent opens; the button stays across agents and reads the open one when pressed. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
const { agentCopyIn } = await importOnce('./agent_copy_button.js');

agentCopyIn(document.querySelector('#live-session-view .session-title-actions'), 'agent', () => {
    const s = state.currentSession;
    return s ? `Agent “${s.display_name || s.name}” (${s.agent_type || 'agent'}, session ${s.session_id}): coral-agent info shows its own state; its chat is GET /api/sessions/live/${s.name}/chat.` : 'A Coral agent page.';
});
