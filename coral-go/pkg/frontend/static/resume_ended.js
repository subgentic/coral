/* Resume an agent that was ended (Kill All, or its own exit) from its earlier chat (#14172, #14208). The agent has no live row any more, so the way back is History's Resume: the chat's resume-info
 * (its folder, name, mode and resume id), then the launch route with resume_session_id on the same board. Used by the inbox's Restart on a question and by Wake Team's offer to resume the
 * members it found ended. Rejects in words, starting nothing, when the folder is gone, unknown, or the chat cannot be read. Plain text only: names and paths go through markHidden. */
import { importOnce } from './import_once.js';
import { markHidden } from './visible_marks.js';
import { serverFetch } from './server_base.js';

const TYPE = /^[a-z][a-z0-9]*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A session as the server names it: {agent_type, session_id, name}, or null when any part is not a plain word (the page never builds a request from text it cannot trust). */
export function endedSessionOf(e) {
    if (!e || typeof e !== 'object') return null;
    const agentType = String(e.agent_type || ''), sid = String(e.session_id || ''), name = String(e.name || '').trim();
    return TYPE.test(agentType) && ID.test(sid) && name ? { agentType, sid, name } : null;
}

/** Resume one ended agent on `server`, joined to `board` ("" for none). */
export async function resumeEndedAgent(server, { agentType, sid, name }, board) {
    const who = markHidden(name, { strict: true });
    const read = await serverFetch(server, `/api/sessions/history/${encodeURIComponent(sid)}/resume-info`);
    if (!read.ok) throw new Error(`${who} is not running on this computer, and its earlier chat could not be read here (HTTP ${read.status}).`);
    const info = await read.json().catch(() => ({}));
    if (!info.working_dir) throw new Error(`${who} is not running, and Coral does not know the folder it worked in, so it cannot be resumed from here. Resume it from All chats.`);
    if (info.working_dir_exists === false) throw new Error(`${who} is not running, and the folder it worked in is gone (${markHidden(info.working_dir, { strict: true })}). Resume it from All chats and pick a folder.`);
    const payload = { working_dir: info.working_dir, agent_type: info.agent_type || agentType, resume_session_id: info.resume_session_id || sid, display_name: info.display_name || name };
    if (board) payload.board_id = payload.board_name = board;
    const mode = info.permission_mode || '';
    if (mode === 'default') payload.permission_mode = 'default';
    else if (mode) {
        const { _getPermissionFlagsForAgentMode } = await importOnce('./permission_flags.js');
        const flags = _getPermissionFlagsForAgentMode(payload.agent_type, mode).split(/\s+/).filter(Boolean);
        if (flags.length) payload.flags = flags;
    }
    const resp = await serverFetch(server, '/api/sessions/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!resp.ok) {
        const why = await resp.json().then(b => (b && typeof b.error === 'string' ? b.error.trim() : ''), () => '');
        throw new Error(why ? `Could not resume ${who}: ${markHidden(why, { strict: true })}` : `Could not resume ${who} (HTTP ${resp.status}).`);
    }
}

/** Resume each of `ended` one after another (a start that fails does not stop the rest). Resolves {resumed: [names], failed: [{name, why}]}. */
export async function resumeEndedAgents(server, ended, board) {
    const out = { resumed: [], failed: [] };
    for (const e of ended.map(endedSessionOf).filter(Boolean)) {
        try { await resumeEndedAgent(server, e, board); out.resumed.push(e.name); }
        catch (err) { out.failed.push({ name: e.name, why: err && err.message ? err.message : 'It did not start.' }); }
    }
    return out;
}

/** What the person is told when it is done: who is back, and who is not and why (the first reason in full). */
export function resumeEndedWords(team, result) {
    const list = a => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
    const parts = [];
    if (result.resumed.length) parts.push(`${list(result.resumed)} ${result.resumed.length === 1 ? 'is' : 'are'} back in "${team}".`);
    if (result.failed.length) parts.push(`${result.failed.map(f => f.name).join(', ')} did not start: ${result.failed[0].why}`);
    return parts.join(' ') || `Nothing to resume in "${team}".`;
}

/** The question before a resume of the ended members Wake Team named. */
export function resumeEndedQuestion(team, names) {
    const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${list} ${names.length === 1 ? 'was' : 'were'} ended in "${team}", so Wake does not apply. Resume ${names.length === 1 ? 'it' : 'them'}? Each starts again in its own folder with its earlier chat, and nothing else changes.`;
}
