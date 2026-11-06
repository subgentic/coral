/* The right sidebar's Info tab (#13917, goals #217 and #218): everything the Info dialog showed, in a tab of the agent's page, and the MCP servers (#9769), the skills the agent loaded (#13209) and its instruction and memory files
 * under it. The fields come from the info route for any computer, as they did in the dialog; the three sections are this computer's own agents only (their routes are the Operator's and never through Coral Hub), and a
 * refusal, a failure or an unread CLI leaves a section out. Read-only: a memory file opens on a click, as text. The Info button (the agent row's menu) opens this tab (openInfoTab); there is no dialog any more.
 * Every look takes a generation before its first await and every answer checks it: an answer for an earlier look (another agent, another computer, the tab shown again) writes nothing. */
import { state } from './state.js';
import { showToast } from './utils.js';
import { setHidden, setText } from './dom_write.js';
import { serverFetch, currentServer, identityKey, keyLabel, isCloud, isLocalServer } from './server_base.js';
import { importOnce } from './import_once.js';

/** The lines the Info tab shows for an agent's MCP servers (#9769): one per server, "name: transport, scope"; [] when the CLI is not one Coral reads, and one line saying none when it reads it and finds none. */
export function mcpLines(result) {
    if (!result || result.supported !== true || !Array.isArray(result.servers)) return [];
    if (!result.servers.length) return ['None configured'];
    const lines = result.servers.map(s => `${String(s.name)}: ${String(s.transport)}, ${String(s.scope)}`);
    if (result.truncated) lines.push('and more');
    return lines;
}

const ROWS = { mcp: ['info-mcp-label', 'info-mcp'], skills: ['info-skills-label', 'info-skills'], memory: ['info-memory-label', 'info-memory'] };
const $ = id => document.getElementById(id);
let tabGen = 0;
const getJson = async (server, path) => { try { const r = await serverFetch(server, path); return r.ok ? await r.json() : null; } catch { return null; } };

function clearRows() {
    for (const [label, val] of Object.values(ROWS)) { $(val)?.replaceChildren(); setHidden($(label), true); setHidden($(val), true); }
}
function say(words) { const note = $('info-tab-note'), grid = $('info-tab-grid'); if (note) { setText(note, words); setHidden(note, !words); } if (grid) setHidden(grid, !!words); }

async function loadMcp(name, sid, server, current) {
    const result = await getJson(server, `/api/sessions/live/${encodeURIComponent(name)}/mcp-servers?session_id=${encodeURIComponent(sid)}`);
    if (!current()) return;
    const lines = mcpLines(result);
    if (!lines.length) return;
    const [label, val] = ROWS.mcp;
    $(val).replaceChildren(...lines.map(l => Object.assign(document.createElement('div'), { textContent: l })));
    setHidden($(label), false); setHidden($(val), false);
}

function fillFields(info, server) {
    const set = (id, v) => { $(id).textContent = v; };
    set('info-agent-name', info.agent_name || ''); set('info-agent-type', info.agent_type || '');
    set('info-tmux-session', info.tmux_session_name || ''); set('info-tmux-command', info.tmux_command || '');
    // Coral's own terminal (pty) has no tmux session to attach to: an empty code box says nothing, so the row says why and where tmux is chosen (#10291)
    const hasAttach = !!info.tmux_command;
    $('info-tmux-command').hidden = !hasAttach; $('info-copy-btn').hidden = !hasAttach; $('info-attach-note').hidden = hasAttach;
    set('info-working-dir', info.working_directory || ''); set('info-log-path', info.log_path || ''); set('info-pane-title', info.pane_title || '');
    set('info-git-branch', info.git_repo && info.git_branch ? `${info.git_repo} : ${info.git_branch}` : (info.git_branch || '—'));
    const hash = info.git_commit_hash ? info.git_commit_hash.substring(0, 8) : '';
    set('info-git-commit', hash ? `${hash} ${info.git_commit_subject || ''}` : '—');
    const promptShown = !!info.prompt;
    $('info-prompt').textContent = promptShown ? info.prompt : ''; setHidden($('info-prompt-label'), !promptShown); setHidden($('info-prompt'), !promptShown);
    const boardShown = !!info.board_name, boardVal = $('info-board');
    setHidden($('info-board-label'), !boardShown); setHidden(boardVal, !boardShown);
    boardVal.replaceChildren();
    if (boardShown) {
        const link = document.createElement('a');
        link.href = '#'; link.textContent = info.board_label || keyLabel(identityKey(server, info.board_name));
        link.style.cssText = 'color:var(--accent);cursor:pointer;text-decoration:underline';
        link.addEventListener('click', e => { e.preventDefault(); if (window.selectBoardProject) window.selectBoardProject(identityKey(server, info.board_name)); }); // listener-ok: a link this tab makes for one board, gone when the fields are filled again
        boardVal.append(link);
    }
}

/** Fills the tab for the agent on screen. Called when the tab is shown and when another agent is picked while it is open. */
export async function showInfoTab() {
    const mine = ++tabGen, server = currentServer(), s = state.currentSession; // before any await: this look's agent and computer
    const current = () => mine === tabGen;
    clearRows();
    if (!s || s.type !== 'live') { say('Pick an agent to see its info.'); return; }
    const name = s.name, sid = s.session_id;
    try {
        const params = new URLSearchParams();
        if (s.agent_type) params.set('agent_type', s.agent_type);
        if (sid) params.set('session_id', sid);
        const qs = params.toString() ? `?${params}` : '';
        const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(name)}/info${qs}`);
        const info = await resp.json();
        if (!current()) return;
        if (info.error) { showToast(info.error, true); say(info.error); return; }
        say(''); fillFields(info, server);
    } catch (e) {
        if (!current()) return;
        showToast('Failed to load session info', true); say('Could not load this agent\'s info.');
        console.error('showInfoTab exception:', e);
        return;
    }
    if (!sid || isCloud() || !isLocalServer(server)) return; // the three sections are this computer's own agents' only
    const { loadAgentSections } = await importOnce('./agent_info_sections.js'); // a lazy module loads the others through importOnce, so a failed load is retried
    if (!current()) return;
    await Promise.all([loadMcp(name, sid, server, current), loadAgentSections({ name, sid, server, current, fetchJson: getJson, rows: { skills: ROWS.skills, memory: ROWS.memory } })]);
}

/** The Info button: the dock open (a phone's is a sheet) on the Info tab, which fills itself. */
export function openInfoTab() {
    window.toggleAgenticPanel?.(true);
    window.switchAgenticTab?.('info', 'top');
}

export function copyInfoCommand() {
    const text = $('info-tmux-command').textContent;
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard');
    }).catch(() => {
        showToast('Failed to copy', true);
    });
}
