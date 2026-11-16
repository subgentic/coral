// Loaded only by the Inbox Getting started launch actions. The guides ship as starter skills.
import { importOnce } from './import_once.js';
const { AGENT_PRESETS, SHIPPED_CAPABILITIES } = await importOnce('./agent_presets.js');
export const GETTING_STARTED_PROMPTS = {
    "agent": AGENT_PRESETS.find(p => p.name === 'Getting started').prompt,
    "team": "You are teaching me how to use Coral and how to work with an agent team. Load the Getting started skill first (getting-started-team), then walk me through it step by step with your team: the inbox, comments, replies, new versions, questions with buttons, and how to get an agent to repeat each step."
};
/** The tour team (#18717): Inbox Try a team opens New team with these three members; the person can still change them. The Orchestrator runs on Opus and Lead Dev and QA on Sonnet 5.5, set directly (the 'opus' and 'sonnet' aliases the model chip offers), not Default (the Operator). */
export const TOUR_TEAM_MEMBERS = [
    { name: 'Orchestrator', model: 'opus', prompt: "You are the orchestrator. Your team is teaching the operator how to use Coral and work with agent teams, so go one step at a time and let them act at each step. Break down the goal, assign work to the team via the message board, and track progress. Delegate to the other agents; do not do the work yourself. Discuss your plan with the operator before posting assignments." },
    { name: 'Lead Dev', model: 'sonnet', prompt: "You are the lead developer. Do the main work the Orchestrator assigns, and show the operator what you are doing as you go. Coordinate with the team via the message board. Wait for instructions from the Orchestrator before starting." },
    { name: 'QA', model: 'sonnet', prompt: "You are QA. Check the team's work for quality and correctness, and say what you checked. Coordinate with the team via the message board. Wait for instructions from the Orchestrator before starting." },
].map(m => ({ ...m, capabilities: { allow: [...SHIPPED_CAPABILITIES], deny: [] } }));
/** The tour team on the provider the person set as their default (#18747): the Orchestrator on its top model, Lead Dev and QA on its everyday one. Ids are the ones Coral reads from each CLI's own list; a provider with no pair here keeps its CLI's default. */
const TOUR_MODELS = { claude: ['opus', 'sonnet'], codex: ['gpt-6-astra', 'gpt-6-sol'], agy: ['gemini-3.1-pro-high', 'gemini-3.8-flash-high'] };
export function tourTeamMembers(provider) {
    const type = provider === 'antigravity' || provider === 'gemini' ? 'agy' : (provider || 'claude');
    if (type === 'claude') return TOUR_TEAM_MEMBERS;
    const [top, everyday] = TOUR_MODELS[type] || ['', ''];
    return TOUR_TEAM_MEMBERS.map((m, i) => ({ ...m, agent_type: type, model: i === 0 ? top : everyday }));
}
