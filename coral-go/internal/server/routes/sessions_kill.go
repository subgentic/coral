package routes

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
)

// Kill terminates a tmux session.
// POST /api/sessions/live/{name}/kill
func (h *SessionsHandler) Kill(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	name := chi.URLParam(r, "name")
	var body struct {
		AgentType string `json:"agent_type"`
		SessionID string `json:"session_id"`
	}
	decodeJSON(r, &body)
	if namesNoSession(name, body.SessionID) {
		writeSessionIDRequired(w)
		return
	}

	slog.Info("killing agent", "agent_name", name, "session_id", body.SessionID, "agent_type", body.AgentType)
	h.modelSwitches.end(body.SessionID, "The agent was ended before the change was confirmed.") // a pending model or level switch does not outlive it (#6219)
	if h.opencode != nil && body.SessionID != "" {
		h.opencode.Stop(body.SessionID) // an opencode agent's server ends with it
	}

	// Use a background context for DB operations so they complete even if
	// the HTTP request context is cancelled (e.g., during tmux command failures).
	bgCtx := context.Background()

	// Look up the live session before deleting so we can clean up board/worktree state
	var boardName, sessionWorkdir string
	var wasSleeping, sessionFound bool
	var worktreePathForCleanup, worktreeRepoForCleanup string
	if body.SessionID != "" {
		if ls, err := h.ss.GetLiveSession(bgCtx, body.SessionID); err == nil && ls != nil {
			sessionFound = true
			sessionWorkdir = ls.WorkingDir
			if ls.BoardName != nil {
				boardName = *ls.BoardName
			}
			wasSleeping = ls.IsSleeping == 1
			if ls.WorktreePath != nil {
				worktreePathForCleanup = *ls.WorktreePath
			}
			if ls.WorktreeRepo != nil {
				worktreeRepoForCleanup = *ls.WorktreeRepo
			}
		}
	}

	// Snapshot the checkout before unregistering the session or removing an
	// owned worktree. A snapshot failure is reported but does not make agents
	// in non-git directories impossible to terminate.
	changesArtifact := ""
	artifactError := ""
	if body.SessionID != "" && body.AgentType != at.Terminal {
		artifactCtx, cancel := context.WithTimeout(bgCtx, 30*time.Second)
		if path, err := h.persistSessionChanges(artifactCtx, body.SessionID, sessionWorkdir); errors.Is(err, errNoGitCheckout) {
			slog.Info("no changes artifact: the session's folder isn't a git checkout", "session_id", body.SessionID)
		} else if err != nil {
			artifactError = changesArtifactProblem
			slog.Warn("persist session changes artifact failed", "session_id", body.SessionID, "error", err)
		} else {
			changesArtifact = path
		}
		cancel()
	}

	// Mark the team member as stopped (if this session belongs to a team)
	if body.SessionID != "" && h.teamStore != nil {
		if member, err := h.teamStore.GetMemberBySessionID(bgCtx, body.SessionID); err == nil && member != nil {
			h.teamStore.UpdateMemberStatus(bgCtx, member.ID, "stopped", member.SessionID)
		}
	}

	// Unregister from DB BEFORE killing the tmux/pty session.
	// This ordering is critical: KillSession may hang or take a long time
	// (e.g., if the tmux socket is in a bad state), and we must ensure the
	// DB row is removed so sleeping sessions don't reappear on server restart.
	if body.SessionID != "" {
		h.chatMeta.forget(body.SessionID)
		if err := h.ss.UnregisterLiveSession(bgCtx, body.SessionID); err != nil {
			log.Printf("[kill] failed to unregister session %s: %v", body.SessionID, err)
		}
	}

	// Clear board pause state if no sleeping sessions remain.
	// The board is paused during sleep, so we must unpause when either:
	// (a) all sessions are gone, or
	// (b) only awake sessions remain (sleeping agents were killed).
	if boardName != "" && h.boardHandler != nil {
		remaining, _ := h.ss.CountBoardSessions(bgCtx, boardName)
		if remaining == 0 {
			h.boardHandler.SetPaused(boardName, false)
			if wasSleeping {
				log.Printf("[kill] cleared board pause state for sleeping board %q (no remaining sessions)", boardName)
			}
		} else if wasSleeping {
			// There are remaining sessions but we just killed a sleeping one.
			// Check if any sleeping sessions are left; if not, unpause.
			var sleepingCount int
			allSessions, _ := h.ss.GetAllLiveSessions(bgCtx)
			for _, ls := range allSessions {
				if ls.BoardName != nil && *ls.BoardName == boardName && ls.IsSleeping == 1 {
					sleepingCount++
				}
			}
			if sleepingCount == 0 {
				h.boardHandler.SetPaused(boardName, false)
				log.Printf("[kill] cleared board pause state for board %q (no sleeping sessions remain, %d awake)", boardName, remaining)
			}
		}
	}

	// Clean up board state file so it doesn't accumulate over time
	removeBoardStateFile(name, h.cfg)

	// Clean up temp files (system prompts, settings, action prompts): only a session that was
	// live, by its own id (#3598).
	if sessionFound {
		agent.CleanupTempFiles(body.SessionID)
	}

	// Sleeping agents have no tmux session (it was terminated when they were
	// put to sleep). Skip all tmux operations — calling KillSession here
	// risks the fuzzy FindPane fallback matching a different agent's session.
	if wasSleeping {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "changes_artifact": changesArtifact, "changes_artifact_error": artifactError})
		return
	}

	// Kill tmux/pty session for awake agents
	h.terminal.KillSession(r.Context(), name, body.AgentType, body.SessionID)

	// Clean up git worktree if this was the last session using it, unless something in it is unsaved (#6701)
	resp := map[string]any{"ok": true, "changes_artifact": changesArtifact, "changes_artifact_error": artifactError}
	if worktreePathForCleanup != "" && worktreeRepoForCleanup != "" {
		// Check if any remaining sessions use this worktree
		remaining, _ := h.ss.CountSessionsWithWorktree(bgCtx, worktreePathForCleanup)
		if remaining == 0 {
			resp["worktree"] = h.removeOwnedWorktree(bgCtx, "kill", worktreeRepoForCleanup, worktreePathForCleanup, h.teamBranchOf(worktreePathForCleanup))
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// putSubscriptionBack returns a board subscription to the session it was on, when a launch failed
// after the subscription had moved to the session that was to start (restart and resume move it
// first, so the new process's first request is a member's). sub is the subscription as it was
// before the move; nil is nothing to put back.
func (h *SessionsHandler) putSubscriptionBack(ctx context.Context, sub *board.Subscriber) {
	if sub == nil || h.bs == nil {
		return
	}
	if _, err := h.bs.Subscribe(ctx, sub.Project, sub.SubscriberID, sub.JobTitle, sub.SessionName,
		sub.OriginServer, sub.ReceiveMode, sub.CanPeek == 1); err != nil {
		log.Printf("[launch] putting %s back on its board %s after a failed launch: %v", sub.SessionName, sub.Project, err)
		return
	}
	writeBoardStateFile(sub.SessionName, sub.Project, sub.JobTitle, h.cfg)
}
