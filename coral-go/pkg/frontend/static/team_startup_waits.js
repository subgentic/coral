/* Team startup questions are already authoritative live-row state. Keep them
 * visible beside the work without guessing that every task is blocked by them. */
import { state } from './state.js';
import { inTeam, sessionServer } from './server_base.js';
import { resolveSessionIdentity, askWords } from './session_state.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('team_startup_waits.css');
const waiting = row => !row.sleeping && !row.archived && row.waiting_for_input && row.waiting_kind === 'startup';
export function drawStartupWaits(host, team) {
    const rows = (state.liveSessions || []).filter(row => inTeam(row, team) && waiting(row));
    const signature = JSON.stringify(rows.map(row => [sessionServer(row), row.session_id, row.waiting_summary]));
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature; host.hidden = !rows.length;
    host.className = 'team-startup-waits notice notice-warn'; host.dataset.teamStartup = '';
    host.replaceChildren(); if (!rows.length) return;
    const title = document.createElement('strong'); title.textContent = 'Team startup needs your answer'; host.append(title);
    for (const row of rows) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-quiet';
        button.textContent = `Waiting on ${resolveSessionIdentity(row)}: ${askWords(row.waiting_summary) || 'Review the startup prompt'}`;
        button.addEventListener('click', () => {
            const current = (state.liveSessions || []).find(item => item.session_id === row.session_id && sessionServer(item) === sessionServer(row));
            if (!current || !waiting(current)) { drawStartupWaits(host, team); return; }
            window.switchNavTab?.('agents');
            Promise.resolve(window.selectLiveSession?.(current.name, current.agent_type, current.session_id, sessionServer(current))).then(() => window.showChatView?.());
        }); host.append(button);
    }
}
export function bindStartupWaits(host, team) {
    const update = () => drawStartupWaits(host, team); update();
    window.addEventListener('coral:live-list-rendered', update);
    return () => window.removeEventListener('coral:live-list-rendered', update);
}
