/* A saved or shared team template built from a running team (moved out of team_actions.js, #15311: it is only read when a team is saved or shared, so it stays out of the start bundle). */
import { state } from './state.js';
import { keyLabel, inTeam, teamFetch, boardFetch } from './server_base.js';

function _buildTeamTemplateFromBoard(boardName) {
    const boardSessions = (state.liveSessions || []).filter(s => inTeam(s, boardName));
    if (!boardSessions.length) return null;

    const agents = [];
    for (const s of boardSessions) {
        const agent = {
            name: s.display_name || s.board_job_title || s.name,
            prompt: s.prompt || '',
        };
        if (s.agent_type) agent.agent_type = s.agent_type;
        if (s.model) agent.model = s.model;
        agent.thinking = s.thinking; agent.permission_mode = s.live_permission_mode; // undefined is not stored
        if (s.capabilities) agent.capabilities = s.capabilities;
        agents.push(agent);
    }
    return { name: keyLabel(boardName), agents, flags: '' };
}

async function _attachKnowledgeToTemplate(boardName, tmpl) {
    try {
        const resp = await teamFetch(boardName, n => `/api/teams/detail/${encodeURIComponent(n)}/knowledge`);
        if (!resp.ok) return tmpl;
        const data = await resp.json();
        if (!data.exists || !data.agents) return tmpl;
        const knowledgeMap = {};
        for (const a of data.agents) {
            knowledgeMap[a.name.toLowerCase()] = a.content;
        }
        for (const agent of tmpl.agents) {
            const slug = agent.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
            if (knowledgeMap[slug]) {
                agent.knowledge = knowledgeMap[slug];
            }
        }
        if (data.index) tmpl.team_knowledge_index = data.index;
    } catch { /* knowledge is optional */ }
    return tmpl;
}

async function _attachWorkingModeToTemplate(boardName, tmpl) {
    try {
        const [modeResp, presetsResp] = await Promise.all([
            boardFetch(boardName, `/working-mode`),
            boardFetch(boardName, `/working-mode/presets`),
        ]);
        if (modeResp.ok) {
            const mode = await modeResp.json();
            if ((mode.mode && mode.mode !== 'none') || mode.custom_instructions) {
                tmpl.working_mode = {
                    mode: mode.mode,
                    dependency_guidance: mode.dependency_guidance || false,
                    asks_are_tasks: mode.asks_are_tasks || false,
                    custom_instructions: mode.custom_instructions || '',
                };
            }
        }
        if (presetsResp.ok) {
            const data = await presetsResp.json();
            const customPresets = (data.presets || []).filter(p => !p.builtin || p.overridden);
            if (customPresets.length > 0) {
                tmpl.workflow_presets = customPresets.map(p => ({
                    id: p.id,
                    name: p.name,
                    instructions: p.instructions || '',
                    builtin: p.builtin || false,
                }));
            }
        }
    } catch { /* working mode is optional */ }
    return tmpl;
}

/** The team's template with its knowledge and working mode, or null when the board has no live agent. */
export async function templateFromBoard(boardName) {
    const tmpl = _buildTeamTemplateFromBoard(boardName);
    return tmpl && await _attachWorkingModeToTemplate(boardName, await _attachKnowledgeToTemplate(boardName, tmpl));
}
