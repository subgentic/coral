/* Open a validated comment-subject reference through existing read-only views.
 * A diff hash is resolved against that exact computer/team/session's changed
 * list; it is never treated as a file path or applied to the selected agent. */
import { importOnce } from './import_once.js';
import { serverFetch, boardTeamKey, normServer, sessionServer } from './server_base.js';
import { openWithQuestionReturn } from './suspend_native_dialog.js';
import { state } from './state.js';
export function openCoralSubject(ref, server, opener) {
    return openWithQuestionReturn(opener, async returnToQuestion => {
        if (ref.kind === 'goal') {
            const nav = await importOnce('./nav.js');
            return nav.go({ view: 'inbox-goals', sub: 'goals', id: boardTeamKey(server, ref.team), item: Number(ref.id) });
        }
        const liveReply = await serverFetch(server, '/api/sessions/live');
        if (!liveReply.ok) throw new Error('The diff computer could not be read.');
        const liveData = await liveReply.json(), live = Array.isArray(liveData) ? liveData : liveData.sessions || [];
        const agent = live.find(a => a.session_id === ref.session && a.board_project === ref.team);
        if (!agent) throw new Error('This diff no longer belongs to a live agent on that team.');
        const query = new URLSearchParams({ session_id: ref.session, worktree: 'follow' });
        const filesReply = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(agent.name)}/files?${query}`);
        if (!filesReply.ok) throw new Error('The changed-file list could not be read.');
        const { files = [] } = await filesReply.json(); let path = '';
        for (const file of files) {
            if (typeof file.filepath !== 'string') continue;
            const sum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.filepath));
            const hash = [...new Uint8Array(sum).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
            if (hash === ref.hash) { path = file.filepath; break; }
        }
        if (!path) throw new Error('This diff is no longer in that agent’s changed files.');
        const sessions = await importOnce('./sessions.js');
        await sessions.selectLiveSession(agent.name, agent.agent_type, ref.session, server);
        if (state.currentSession?.session_id !== ref.session || sessionServer(state.currentSession) !== normServer(server)) throw new Error('The diff’s agent could not be opened.');
        const preview = await importOnce('./preview_pane.js');
        preview.openPreviewTab(path, undefined, { diff: true, ...(returnToQuestion ? { onClose: returnToQuestion } : {}) });
        return { waitForClose: true };
    });
}
