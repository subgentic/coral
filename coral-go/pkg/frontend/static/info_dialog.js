/* Moved out of modals.js as it was (#4684): The Info dialog (agent session info and its copy button). No behaviour change. */
import { state } from './state.js';
import { showToast } from './utils.js';
import { setHidden } from './dom_write.js';
import { serverFetch, currentServer, identityKey, keyLabel, isCloud, isLocalServer } from './server_base.js';
import { importOnce } from './import_once.js';

/** The lines the Info dialog shows for an agent's MCP servers (#9769): one per server, "name: transport, scope"; [] when the CLI is not one Coral reads, and one line saying none when it reads it and finds none. */
export function mcpLines(result) {
    if (!result || result.supported !== true || !Array.isArray(result.servers)) return [];
    if (!result.servers.length) return ['None configured'];
    const lines = result.servers.map(s => `${String(s.name)}: ${String(s.transport)}, ${String(s.scope)}`);
    if (result.truncated) lines.push('and more');
    return lines;
}

let mcpAsked = '';
/** Fills the dialog's MCP servers row from the server, read-only and for this computer's own agents only (the route is the Operator's and never through Coral Hub). A failure or an unread CLI leaves the row hidden. */
async function showMcpServers(name, sid) {
    const label = document.getElementById('info-mcp-label'), val = document.getElementById('info-mcp');
    if (!label || !val) return;
    setHidden(label, true); setHidden(val, true);
    if (!sid || isCloud() || !isLocalServer(currentServer())) return;
    mcpAsked = sid;
    let result = null;
    try {
        const r = await serverFetch(currentServer(), `/api/sessions/live/${encodeURIComponent(name)}/mcp-servers?session_id=${encodeURIComponent(sid)}`);
        result = r.ok ? await r.json() : null;
    } catch { result = null; }
    if (mcpAsked !== sid) return; // the dialog was opened for another agent meanwhile
    const lines = mcpLines(result);
    if (!lines.length) return;
    val.replaceChildren(...lines.map(l => Object.assign(document.createElement('div'), { textContent: l })));
    setHidden(label, false); setHidden(val, false);
}

let sectionsAsked = '';
const getJson = async (path) => { try { const r = await serverFetch(currentServer(), path); return r.ok ? await r.json() : null; } catch { return null; } };
/** The dialog's Skills and Memory rows (#13209, goal #218), beside the MCP row: what the agent LOADED through skills get (a record, not a folder scan) and its instruction and memory files, each opened read-only on a click. Same rule as the MCP row: this computer's own agents, the Operator's routes, a failure leaves the row hidden. */
async function showAgentSections(name, sid) {
    const rows = { skills: ['info-skills-label', 'info-skills'], memory: ['info-memory-label', 'info-memory'] };
    for (const [label, val] of Object.values(rows)) { setHidden(document.getElementById(label), true); setHidden(document.getElementById(val), true); }
    if (!sid || isCloud() || !isLocalServer(currentServer())) return;
    sectionsAsked = sid;
    const q = `session_id=${encodeURIComponent(sid)}`, base = `/api/sessions/live/${encodeURIComponent(name)}`;
    const { skillLines, memoryItems, memoryText } = await importOnce('./agent_info_sections.js'); // a lazy module loads the others through importOnce, so a failed load is retried
    const [skills, memory] = await Promise.all([getJson(`${base}/loaded-skills?${q}`), getJson(`${base}/memory?${q}`)]);
    if (sectionsAsked !== sid) return; // the dialog was opened for another agent meanwhile
    const lines = skillLines(skills);
    if (lines.length) { fill('info-skills', lines.map(l => Object.assign(document.createElement('div'), { textContent: l }))); }
    const items = memoryItems(memory);
    if (items.length) {
        const nodes = items.map(it => {
            if (!it.id) return Object.assign(document.createElement('div'), { textContent: it.label });
            const b = Object.assign(document.createElement('button'), { type: 'button', className: 'info-memory-open', textContent: it.label });
            b.addEventListener('click', async () => { // listener-ok: a button this dialog makes for one file, gone when the dialog is filled again
                const pre = document.getElementById('info-memory-text'); pre.textContent = 'Loading...'; setHidden(pre, false);
                const text = memoryText(await getJson(`${base}/memory/${encodeURIComponent(it.id)}?${q}`));
                if (sectionsAsked === sid) pre.textContent = text;
            });
            return b;
        });
        const pre = Object.assign(document.createElement('pre'), { id: 'info-memory-text', className: 'info-memory-text', hidden: true });
        fill('info-memory', [...nodes, pre]);
    }
}
function fill(id, nodes) {
    const val = document.getElementById(id), label = document.getElementById(id + '-label');
    val.replaceChildren(...nodes);
    setHidden(label, false); setHidden(val, false);
}

export async function showInfoModal() {
    if (!state.currentSession || state.currentSession.type !== "live") {
        showToast("No live session selected", true);
        return;
    }

    const name = state.currentSession.name;
    const agentType = state.currentSession.agent_type || "";

    try {
        const params = new URLSearchParams();
        if (agentType) params.set("agent_type", agentType);
        const sid = state.currentSession.session_id;
        if (sid) params.set("session_id", sid);
        const qs = params.toString() ? `?${params}` : "";
        const resp = await serverFetch(currentServer(), `/api/sessions/live/${encodeURIComponent(name)}/info${qs}`);
        const info = await resp.json();

        if (info.error) {
            showToast(info.error, true);
            return;
        }

        document.getElementById("info-agent-name").textContent = info.agent_name || "";
        document.getElementById("info-agent-type").textContent = info.agent_type || "";
        document.getElementById("info-tmux-session").textContent = info.tmux_session_name || "";
        document.getElementById("info-tmux-command").textContent = info.tmux_command || "";
        // Coral's own terminal (pty) has no tmux session to attach to: an empty code box says nothing, so the row says why and where tmux is chosen (#10291)
        const hasAttach = !!info.tmux_command;
        document.getElementById("info-tmux-command").hidden = !hasAttach;
        document.getElementById("info-copy-btn").hidden = !hasAttach;
        document.getElementById("info-attach-note").hidden = hasAttach;
        document.getElementById("info-working-dir").textContent = info.working_directory || "";
        document.getElementById("info-log-path").textContent = info.log_path || "";
        document.getElementById("info-pane-title").textContent = info.pane_title || "";
        const gitDisplay = info.git_repo && info.git_branch ? `${info.git_repo} : ${info.git_branch}` : (info.git_branch || "—");
        document.getElementById("info-git-branch").textContent = gitDisplay;
        const commitHash = info.git_commit_hash ? info.git_commit_hash.substring(0, 8) : "";
        const commitSubject = info.git_commit_subject || "";
        document.getElementById("info-git-commit").textContent = commitHash ? `${commitHash} ${commitSubject}` : "—";

        // Prompt
        const promptLabel = document.getElementById("info-prompt-label");
        const promptVal = document.getElementById("info-prompt");
        if (info.prompt) {
            promptLabel.style.display = "";
            promptVal.style.display = "";
            promptVal.textContent = info.prompt;
        } else {
            promptLabel.style.display = "none";
            promptVal.style.display = "none";
        }

        // Message Board (clickable link)
        const boardLabel = document.getElementById("info-board-label");
        const boardVal = document.getElementById("info-board");
        if (info.board_name) {
            boardLabel.style.display = "";
            boardVal.style.display = "";
            const boardLink = document.createElement("a");
            boardLink.href = "#";
            boardLink.textContent = info.board_label || keyLabel(identityKey(currentServer(), info.board_name));
            boardLink.style.cssText = "color:var(--accent);cursor:pointer;text-decoration:underline";
            boardLink.onclick = (e) => {
                e.preventDefault();
                hideInfoModal();
                if (window.selectBoardProject) window.selectBoardProject(identityKey(currentServer(), info.board_name));
            };
            boardVal.innerHTML = "";
            boardVal.appendChild(boardLink);
        } else {
            boardLabel.style.display = "none";
            boardVal.style.display = "none";
        }

        document.getElementById("info-modal").style.display = "flex";
        showMcpServers(name, sid);
        showAgentSections(name, sid);
    } catch (e) {
        showToast("Failed to load session info", true);
        console.error("showInfoModal exception:", e);
    }
}

export function hideInfoModal() {
    document.getElementById("info-modal").style.display = "none";
}

export function copyInfoCommand() {
    const text = document.getElementById("info-tmux-command").textContent;
    navigator.clipboard.writeText(text).then(() => {
        showToast("Copied to clipboard");
    }).catch(() => {
        showToast("Failed to copy", true);
    });
}
