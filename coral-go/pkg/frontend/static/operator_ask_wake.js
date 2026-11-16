import { markHidden } from './visible_marks.js';
import { state } from './state.js';
import { normServer, serverFetch, sessionServer } from './server_base.js';
import { importOnce } from './import_once.js';

export async function wakeMember(a, name) {
    const who = markHidden(name, { strict: true });
    const server = normServer(a.server);
    const r = await serverFetch(server, `/api/board/${encodeURIComponent(a.board)}/subscribers`);
    if (!r.ok) throw new Error(`Could not read this team's members (HTTP ${r.status}).`);
    const subs = await r.json().catch(() => []);
    const sub = (Array.isArray(subs) ? subs : []).find(x => x && x.subscriber_id === name);
    if (!sub || !sub.session_name) throw new Error(`${who} is not a member of this team that Coral can wake.`);
    let live = (state.liveSessions || []).find(s => sessionServer(s) === server && `${s.agent_type}-${s.session_id}` === sub.session_name);
    if (!live) {
        // The page's list can lack an agent that is running (not loaded yet, or stale): only the server's own list says whether it is gone. A session that is running is never resumed (#14420, after #14172).
        const real = await serverLiveRow(server, sub.session_name);
        if (real.failed) throw new Error(`Could not check whether ${who} is running (${real.failed}), so nothing was started.`);
        if (!real.row) return resumeEndedMember(server, a, name, who, sub.session_name); // an agent Stop agents (or its own exit) ended has no live row: its chat is resumed, as History's Resume does (#14172)
        live = real.row;
        if (!live.sleeping) { try { await (await importOnce('./api.js')).loadLiveSessions(); } catch { /* the list refreshes on its own tick */ } throw new Error(`${who} is running.`); } // the page's list is brought up to date, nothing is launched
    }
    if (!live.sleeping) throw new Error(`${who} is not asleep.`);
    const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(live.session_id)}/wake`, { method: 'POST' });
    if (!resp.ok) { // the server says why in a sentence (a CLI not installed, a path it cannot run: cli_not_found, cli_path_unusable, cli_untrusted_mount) and what to set: show it, not the status code (#12049)
        const why = await resp.json().then(b => (b && typeof b.error === 'string' ? b.error.trim() : ''), () => '');
        throw new Error(why ? `Could not wake ${who}: ${markHidden(why, { strict: true })}` : `Could not wake ${who} (HTTP ${resp.status}).`);
    }
}

/** The row the SERVER lists for a session name ("<cli>-<session id>") on `server`: {row} (null when it lists none) or {failed} in words when it cannot be asked or answers something that is not a list. */
async function serverLiveRow(server, sessionName) {
    let r; try { r = await serverFetch(server, '/api/sessions/live'); } catch { return { failed: 'the computer did not answer' }; }
    if (!r.ok) return { failed: `HTTP ${r.status}` };
    const raw = await r.json().catch(() => null);
    const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.sessions) ? raw.sessions : null);
    if (!rows) return { failed: 'its list was not readable' };
    // The list was asked of ONE computer, so its rows are that computer's: a remote answers machine-local rows with no server tag (the tag is what the page adds when it merges lists), and an untagged row must not be taken for the local computer's (#14420, UI Reviewer). Only a row tagged for ANOTHER computer (a hub's merged list) is not this one's.
    return { row: rows.find(s => s && (!s.server || sessionServer(s) === server) && `${s.agent_type}-${s.session_id}` === sessionName) || null };
}

/** An ended agent's Restart from a question (#14172): no live row any more, so its earlier chat is resumed (resume_ended.js), under its own name and team. */
async function resumeEndedMember(server, a, name, who, sessionName) {
    const m = /^([a-z][a-z0-9]*)-([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(sessionName || ''));
    if (!m) throw new Error(`${who} is not running on this computer.`);
    const { resumeEndedAgent } = await importOnce('./resume_ended.js');
    return resumeEndedAgent(server, { agentType: m[1], sid: m[2], name }, a.board);
}

