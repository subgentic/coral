package routes

import (
	"errors"
	"github.com/go-chi/chi/v5"
	"log"
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentmodels"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// ── Team Sleep/Wake ──────────────────────────────────────────────────────

// SleepStatus returns whether a team board is sleeping.
// GET /api/sessions/live/team/{boardName}/sleep-status
func (h *SessionsHandler) SleepStatus(w http.ResponseWriter, r *http.Request) {
	boardName := urlParam(r, "boardName")
	boards, err := h.ss.GetSleepingBoardNames(r.Context())
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"sleeping": false})
		return
	}
	sleeping := false
	for _, b := range boards {
		if b == boardName {
			sleeping = true
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sleeping": sleeping})
}

// Sleep puts a team to sleep: sets is_sleeping, kills tmux sessions, pauses board.
// POST /api/sessions/live/team/{boardName}/sleep
func (h *SessionsHandler) Sleep(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	boardName := urlParam(r, "boardName")
	ctx := r.Context()

	// Check if any sessions exist on this board
	allLive, _ := h.ss.GetAllLiveSessions(ctx)
	var boardSessions []store.LiveSession
	for _, ls := range allLive {
		if ls.BoardName != nil && *ls.BoardName == boardName {
			boardSessions = append(boardSessions, ls)
		}
	}
	if len(boardSessions) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "No sessions found on that board"})
		return
	}

	// Update team status to sleeping (if a team exists for this board)
	if h.teamStore != nil {
		if team, err := h.teamStore.GetTeam(ctx, boardName); err == nil && team != nil && team.Status == "running" {
			h.teamStore.SetAllMembersStatus(ctx, team.ID, "active", "sleeping")
			h.teamStore.UpdateTeamStatus(ctx, team.ID, "sleeping")
		}
	}

	// Set all board sessions to sleeping
	affected, err := h.ss.SetBoardSleeping(ctx, boardName, true)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}

	// Pause the message board
	boardPaused := false
	if h.boardHandler != nil {
		h.boardHandler.PauseForSleep(boardName) // auto-wake may lift it; a person's own Pause is kept (#286)
		boardPaused = true
	}

	// Kill tmux sessions for agents on this board
	killed := 0
	for _, ls := range boardSessions {
		err := h.terminal.KillSessionOnly(ctx, ls.AgentName, ls.AgentType, ls.SessionID)
		if err == nil {
			killed++
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                true,
		"sleeping":          true,
		"sessions_affected": affected,
		"sessions_killed":   killed,
		"board_paused":      boardPaused,
	})
}

// Wake wakes a sleeping team: relaunches sessions, clears sleeping, unpauses board.
// POST /api/sessions/live/team/{boardName}/wake
func (h *SessionsHandler) Wake(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	boardName := urlParam(r, "boardName")
	ctx, cancel := lifecycleCtx(r.Context()) // a team wake runs to its end whatever the request does (#5171)
	defer func() { cancel() }()

	// Find sleeping sessions on this board and relaunch
	allLive, _ := h.ss.GetAllLiveSessions(ctx)
	sleepingHere := 0
	for _, ls := range allLive {
		if ls.IsSleeping == 1 && ls.IsArchived != 1 && ls.BoardName != nil && *ls.BoardName == boardName {
			sleepingHere++
		}
	}
	cancel()
	ctx, cancel = lifecycleCtxN(r.Context(), sleepingHere) // the bound grows with the team (#5213)

	relaunched := 0
	for _, ls := range allLive {
		if ls.IsSleeping != 1 || ls.IsArchived == 1 || ls.BoardName == nil || *ls.BoardName != boardName {
			continue // archived agents stay asleep on team wake; they wake only one at a time
		}

		// Relaunch the session
		if err := h.wakeExistingSession(ctx, &ls); err != nil {
			log.Printf("Failed to wake session %s — keeping asleep: %v", ls.SessionID[:8], err)
			continue
		}
		if humanInputCaller(r) {
			h.resetAutoResume(ls.SessionID) // a person's wake (#3613, Security's SHOULD 1)
		}
		relaunched++
	}

	// Clean up orphaned sleeping rows (duplicates where an awake version exists)
	if cleaned, err := h.ss.CleanupOrphanedSleeping(ctx); err == nil && cleaned > 0 {
		log.Printf("[wake] cleaned %d orphaned sleeping rows", cleaned)
	}

	// Update team status to running
	if relaunched > 0 && h.teamStore != nil {
		if team, err := h.teamStore.GetTeam(ctx, boardName); err == nil && team != nil && team.Status == "sleeping" {
			h.teamStore.WakeTeamMembers(ctx, team.ID)
			h.teamStore.UpdateTeamStatus(ctx, team.ID, "running")
		}
	}

	// Unpause board if at least one agent was woken
	boardPaused := true
	if relaunched > 0 && h.boardHandler != nil {
		h.boardHandler.SetPaused(boardName, false)
		boardPaused = false
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                  true,
		"sleeping":            false,
		"sessions_relaunched": relaunched,
		"board_paused":        boardPaused,
	})
}

// codexSessionSaved is agent.CodexSessionSaved (a variable so a test can say).
var codexSessionSaved = agent.CodexSessionSaved

// wakeExistingSession recreates the tmux/pty session for a sleeping agent
// using the EXISTING session ID. Preserves display name, board subscriptions, and history.
// wakeFlags is the agent's stored flags with the model and thinking level it runs now: a live switch (#4969) changes the stored model and level, not the flags the agent was started with, so a wake that
// used the stored flags as they were started the agent again at the old level (#6219). The model's and the level's own flags are replaced, never doubled.
func wakeFlags(ls *store.LiveSession) []string {
	flags := store.UnmarshalFlags(ls.Flags)
	if m := strings.TrimSpace(ptr.Value(ls.Model)); m != "" {
		if modelArgs, err := agentmodels.ModelArgs(m); err == nil {
			var kept []string
			for i := 0; i < len(flags); i++ {
				f := flags[i]
				if f == "--model" || f == "-m" {
					i++ // its value
					continue
				}
				if strings.HasPrefix(f, "--model=") || strings.HasPrefix(f, "-m=") {
					continue
				}
				kept = append(kept, f)
			}
			flags = append(kept, modelArgs...)
		}
	}
	if level := ptr.Value(ls.Thinking); level != "" && agentmodels.ValidThinking(ls.AgentType, level) {
		flags = append(agentmodels.StripThinkingFlags(flags), agentmodels.ThinkingArgs(ls.AgentType, level)...)
	}
	return flags
}

// ── Individual Session Sleep/Wake ────────────────────────────────────────

// SleepSession puts a single agent to sleep.
// POST /api/sessions/live/{sessionID}/sleep
func (h *SessionsHandler) SleepSession(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	sessionID := chi.URLParam(r, "sessionID")
	ctx := r.Context()

	sess, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || sess == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Session not found"})
		return
	}

	h.modelSwitches.end(sessionID, "The agent was put to sleep before the change was confirmed.") // #6219
	h.ss.SetSessionSleeping(ctx, sessionID, true)

	// Kill tmux session to free resources
	if err := h.terminal.KillSessionOnly(ctx, sess.AgentName, sess.AgentType, sessionID); err != nil {
		log.Printf("Failed to kill tmux for session %s during sleep: %v", sessionID[:8], err)
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sleeping": true})
}

// WakeSession wakes a single sleeping agent. Waking an archived agent also
// unarchives it: it is an explicit request for that one agent.
// POST /api/sessions/live/{sessionID}/wake
func (h *SessionsHandler) WakeSession(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	sessionID := chi.URLParam(r, "sessionID")
	ctx, cancel := lifecycleCtx(r.Context()) // a wake runs to its end whatever the request does (#5171)
	defer cancel()

	sess, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || sess == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Session not found"})
		return
	}
	if sess.IsSleeping != 1 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Session is not sleeping"})
		return
	}

	if err := h.wakeExistingSession(ctx, sess); err != nil {
		log.Printf("Failed to wake session %s: %v", sessionID[:8], err)
		if errors.Is(err, ErrStillInOldTmux) {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error(), "code": "still_in_old_tmux"})
			return
		}
		if refuse, ok := cliPathRefusal(viaHub(ctx, r), err); ok { // the setting to fix, not a bare "failed" (#115)
			refuse(w)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Failed to relaunch session"})
		return
	}
	// A person's wake (never an agent's) lets Coral auto-resume it again (#3613, Security's SHOULD 1).
	if humanInputCaller(r) {
		h.resetAutoResume(sess.SessionID)
	}
	// One the Operator chose to wake from the over-the-cap list (#3636) gets Coral's notice.
	if h.takePendingAutoWake(sess.SessionID) {
		h.sendAutoWakeNotice(ctx, *sess)
	}

	// Unpause the board if this agent was on one
	bn := ptr.Value(sess.BoardName)
	if bn != "" && h.boardHandler != nil {
		h.boardHandler.SetPaused(bn, false)
	}

	reply := map[string]any{"ok": true, "sleeping": false}
	if note := takeWakeNote(sess.SessionID); note != "" {
		reply["note"] = note // its launch line was not typed into a shell of unknown contents (Security on #216)
	}
	writeJSON(w, http.StatusOK, reply)
}

// ArchiveSession archives an agent: a running agent is put to sleep first
// (its terminal is killed), then marked archived. Archived agents are left out
// of Wake All, team wake and task assignment until unarchived or woken.
// POST /api/sessions/live/{sessionID}/archive
func (h *SessionsHandler) ArchiveSession(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	sessionID := chi.URLParam(r, "sessionID")
	ctx := r.Context()

	sess, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || sess == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Session not found"})
		return
	}
	if sess.IsSleeping != 1 {
		if err := h.ss.SetSessionSleeping(ctx, sessionID, true); err != nil {
			errInternalServer(w, err.Error())
			return
		}
		if err := h.terminal.KillSessionOnly(ctx, sess.AgentName, sess.AgentType, sessionID); err != nil {
			log.Printf("Failed to kill tmux for session %s during archive: %v", sessionID[:min(8, len(sessionID))], err)
		}
	}
	if err := h.ss.SetSessionArchived(ctx, sessionID, true); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sleeping": true, "archived": true})
}

// UnarchiveSession returns an archived agent to plain sleeping. It does not
// start the agent; wake does that.
// POST /api/sessions/live/{sessionID}/unarchive
func (h *SessionsHandler) UnarchiveSession(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	sessionID := chi.URLParam(r, "sessionID")
	ctx := r.Context()

	sess, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || sess == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Session not found"})
		return
	}
	if err := h.ss.SetSessionArchived(ctx, sessionID, false); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sleeping": sess.IsSleeping == 1, "archived": false})
}

// ── Bulk Sleep/Wake All ─────────────────────────────────────────────────

// SleepAll puts all active agents to sleep.
// POST /api/sessions/live/sleep-all
func (h *SessionsHandler) SleepAll(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	ctx := r.Context()
	allLive, _ := h.ss.GetAllLiveSessions(ctx)

	var active []store.LiveSession
	for _, ls := range allLive {
		if ls.IsSleeping != 1 {
			active = append(active, ls)
		}
	}
	if len(active) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sessions_affected": 0})
		return
	}

	boards := map[string]bool{}
	killed := 0
	for _, ls := range active {
		h.ss.SetSessionSleeping(ctx, ls.SessionID, true)
		if ls.BoardName != nil && *ls.BoardName != "" {
			boards[*ls.BoardName] = true
		}
		err := h.terminal.KillSessionOnly(ctx, ls.AgentName, ls.AgentType, ls.SessionID)
		if err == nil {
			killed++
		} else {
			log.Printf("Failed to kill tmux for session %s during sleep-all: %v", ls.SessionID[:8], err)
		}
	}

	// Pause all affected boards
	if h.boardHandler != nil {
		for b := range boards {
			h.boardHandler.PauseForSleep(b)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                true,
		"sessions_affected": len(active),
		"sessions_killed":   killed,
	})
}

// WakeAll wakes all sleeping agents except archived ones.
// POST /api/sessions/live/wake-all
func (h *SessionsHandler) WakeAll(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS()                         // the feed shows the change now, not on the next tick
	ctx, cancel := lifecycleCtx(r.Context()) // a wake of all runs to its end whatever the request does (#5171)
	defer func() { cancel() }()
	allLive, _ := h.ss.GetAllLiveSessions(ctx)

	var sleeping []store.LiveSession
	for _, ls := range allLive {
		if ls.IsSleeping == 1 && ls.IsArchived == 0 { // archived agents are left asleep
			sleeping = append(sleeping, ls)
		}
	}
	cancel()
	ctx, cancel = lifecycleCtxN(r.Context(), len(sleeping)) // 2 minutes and 5 s a session: the last of many is not cut off (#5213)
	if len(sleeping) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sessions_relaunched": 0})
		return
	}

	boards := map[string]bool{}
	relaunched := 0
	for _, ls := range sleeping {
		if err := h.wakeExistingSession(ctx, &ls); err != nil {
			log.Printf("Failed to wake session %s — keeping asleep: %v", ls.SessionID[:8], err)
			continue
		}
		if humanInputCaller(r) {
			h.resetAutoResume(ls.SessionID) // a person's wake (#3613, Security's SHOULD 1)
		}
		relaunched++
		if bn := ptr.Value(ls.BoardName); bn != "" {
			boards[bn] = true
		}
	}

	// Unpause affected boards
	if h.boardHandler != nil {
		for b := range boards {
			h.boardHandler.SetPaused(b, false)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sessions_relaunched": relaunched})
}

// sleepReason is why Coral put a sleeping agent to sleep (#3344): "terminal_gone" when its
// terminal session no longer exists, "" when the user (or a team action) did.
func sleepReason(ls store.LiveSession) string {
	if ls.SleepReason == nil {
		return ""
	}
	return *ls.SleepReason
}
