package routes

import (
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// ArchiveTeam puts a team away (#21850): every awake agent is put to sleep (its terminal is killed), every agent is archived, the board is marked archived and
// paused (so its health check, reminders and nudges stop), and nothing is deleted. The team's last Orchestrator is archived too: the whole team goes, so the
// rule that a team keeps one (#19673) does not apply. Restore is DELETE of the same path.
// POST /api/board/{project}/archive
func (h *SessionsHandler) ArchiveTeam(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS()
	project, ctx := chi.URLParam(r, "project"), r.Context()
	if h.bs == nil {
		errInternalServer(w, "the message board is not available")
		return
	}
	if known, err := h.bs.BoardKnown(ctx, project); err != nil {
		errInternalServer(w, err.Error())
		return
	} else if !known {
		errNotFound(w, "no team named "+project)
		return
	}
	sessions, err := h.ss.GetBoardSessions(ctx, project)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	archived, slept := 0, 0
	var archivedIDs []string // only these come back on Restore: an agent archived on its own stays archived
	for _, sess := range sessions {
		if sess.IsArchived == 1 {
			continue
		}
		if sess.IsSleeping != 1 {
			if err := h.ss.SetSessionSleeping(ctx, sess.SessionID, true); err != nil {
				errInternalServer(w, err.Error())
				return
			}
			h.stopOpencode(sess.SessionID)
			if err := h.terminal.KillSessionOnly(ctx, sess.AgentName, sess.AgentType, sess.SessionID); err != nil {
				log.Printf("Failed to kill tmux for session %s during team archive: %v", sess.SessionID[:min(8, len(sess.SessionID))], err)
			}
			slept++
		}
		if err := h.ss.SetSessionArchived(ctx, sess.SessionID, true); err != nil {
			errInternalServer(w, err.Error())
			return
		}
		archived++
		archivedIDs = append(archivedIDs, sess.SessionID)
	}
	if err := h.bs.SetBoardArchived(ctx, project, true); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if err := h.bs.SetBoardArchivedAgents(ctx, project, archivedIDs); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if h.boardHandler != nil {
		h.boardHandler.SetPaused(project, true)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "archived": true, "agents_slept": slept, "agents_archived": archived})
}

// RestoreTeam brings an archived team back: its agents are unarchived (each stays asleep; Wake team starts them), the board's archived flag and its pause are cleared.
// DELETE /api/board/{project}/archive
func (h *SessionsHandler) RestoreTeam(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS()
	project, ctx := chi.URLParam(r, "project"), r.Context()
	if h.bs == nil {
		errInternalServer(w, "the message board is not available")
		return
	}
	if known, err := h.bs.BoardKnown(ctx, project); err != nil {
		errInternalServer(w, err.Error())
		return
	} else if !known {
		errNotFound(w, "no team named "+project)
		return
	}
	sessions, err := h.ss.GetBoardSessions(ctx, project)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	mine := map[string]bool{}
	for _, id := range h.bs.BoardArchivedAgents(ctx, project) {
		mine[id] = true
	}
	restored := 0
	for _, sess := range sessions {
		if sess.IsArchived != 1 || !mine[sess.SessionID] {
			continue
		}
		if err := h.ss.SetSessionArchived(ctx, sess.SessionID, false); err != nil {
			errInternalServer(w, err.Error())
			return
		}
		restored++
	}
	if err := h.bs.SetBoardArchived(ctx, project, false); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if h.boardHandler != nil {
		h.boardHandler.SetPaused(project, false)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "archived": false, "agents_restored": restored})
}
