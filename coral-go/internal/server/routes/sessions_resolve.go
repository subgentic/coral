package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// ResolveSession returns the authoritative routing and identity metadata for a
// stable session ID. Unknown UUIDs deliberately return a not_found state with
// HTTP 200 so a freshly opened popout can retry while the session index catches
// up without ever falling back to an agent name.
func (h *SessionsHandler) ResolveSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	parsed, err := uuid.Parse(sessionID)
	if err != nil || parsed.String() != sessionID {
		errBadRequest(w, "invalid session_id")
		return
	}

	ls, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if ls == nil {
		var indexed bool
		if err := h.db.Reader().GetContext(r.Context(), &indexed,
			"SELECT EXISTS(SELECT 1 FROM session_index WHERE session_id = ?)", sessionID); err != nil {
			errInternalServer(w, err.Error())
			return
		}
		state := "not_found"
		if indexed {
			state = "finished"
		}
		writeJSON(w, http.StatusOK, withDisplayActivityHint(map[string]any{
			"session_id":        sessionID,
			"state":             state,
			"active":            false,
			"sleeping":          false,
			"agent_type":        nil,
			"name":              nil,
			"tmux_session":      nil,
			"working_directory": nil,
			"display_name":      nil,
			"auto_name":         nil,
			"board_project":     nil,
			"board_job_title":   nil,
			"icon":              nil,
			"status":            nil,
			"summary":           nil,
			"summary_at":        nil,
			"first_prompt":      nil,
			"waiting_for_input": false,
			"waiting_reason":    nil,
			"waiting_summary":   nil,
			"waiting_since":     nil,
			"waiting_kind":      nil,
			"working":           false,
			"done":              false,
			"stuck":             false,
			"not_started":       false,
			"starting":          false,
		}, nil, nil))
		return
	}

	var status string
	if err := h.db.Reader().GetContext(r.Context(), &status,
		"SELECT status FROM live_sessions WHERE session_id = ?", sessionID); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	active := status == "active"
	sleeping := active && ls.IsSleeping == 1
	state := "finished"
	if sleeping {
		state = "sleeping"
	} else if active {
		state = "active"
	}
	var tmuxSession any
	if active && !sleeping {
		tmuxSession = naming.SessionName(ls.AgentType, ls.SessionID)
	}
	logInfo := getLogStatus("")
	firstPrompt := h.sleepingFirstPrompt(*ls)
	if !sleeping {
		logInfo = h.cachedLogStatus(naming.LogFile(h.cfg.LogDir, ls.AgentType, ls.SessionID))
		firstPrompt = h.jsonl.FirstUserPrompt(ls.SessionID, ls.WorkingDir, ls.AgentType)
	}
	initialStatus, _ := logInfo["status"].(string)
	summary := ""
	// Same derivation as the list and WebSocket rows. The popout merges this
	// record over the live row, so the state fields must agree with it.
	var liveState SessionState
	if active && !sleeping {
		staleness, _ := logInfo["staleness_seconds"].(float64)
		liveState = h.deriveSingleSessionState(r.Context(), sessionID, staleness)
	}
	displayHint, displayHintAt := h.singleDisplayActivityHint(r.Context(), ls.AgentType, naming.SessionName(ls.AgentType, sessionID), sessionID, liveState)
	out := map[string]any{
		"session_id":        ls.SessionID,
		"state":             state,
		"active":            active,
		"sleeping":          sleeping,
		"archived":          sleeping && ls.IsArchived == 1,
		"agent_type":        ls.AgentType,
		"name":              ls.AgentName,
		"tmux_session":      tmuxSession,
		"working_directory": ls.WorkingDir,
		"display_name":      ls.DisplayName,
		"auto_name":         nil,
		"board_project":     ls.BoardName,
		"board_label":       h.boardLabel(ptr.Value(ls.BoardName)),
		"board_job_title":   ls.DisplayName,
		"icon":              ls.Icon,
		"name_color":        ls.NameColor,
		"status":            ptr.NullIfEmpty(initialStatus),
		"summary":           ptr.NullIfEmpty(summary),
		"summary_at":        nil,
		"first_prompt":      firstPrompt,
		"waiting_for_input": liveState.NeedsInput,
		"awaiting_user":     liveState.AwaitingUser,
		"waiting_reason":    ptr.NullIfEmpty(liveState.WaitingReason),
		"waiting_summary":   waitingLine(waitingSource(liveState.WaitingWants, liveState.WaitingSummary)),
		"waiting_since":     waitingSince(liveState),
		"waiting_kind":      ptr.NullIfEmpty(liveState.WaitingKind),
		"working":           liveState.Working,
		"done":              false,
		"stuck":             false,
		"not_started":       false,
		"starting":          false,
	}
	withDisplayActivityHint(out, displayHint, displayHintAt)
	for k, v := range h.autoAcceptPayload(r.Context(), ls.SessionID) {
		out[k] = v
	}
	// An agent's token gets the roster fields of a session that is not its own or its board's (the live list's rule, #5041): not the working directory, the prompt or the waiting text.
	if owner, isAgent := VerifiedSession(r.Context()); isAgent && !h.agentMayReadSession(r.Context(), owner.SessionID, ls) {
		out = rosterRow(out)
	}
	writeJSON(w, http.StatusOK, out)
}

// agentMayReadSession reports whether the agent whose session is ownerSessionID may read ls whole: its own session, or one on its own board.
func (h *SessionsHandler) agentMayReadSession(ctx context.Context, ownerSessionID string, ls *store.LiveSession) bool {
	if ls.SessionID == ownerSessionID {
		return true
	}
	own, err := h.ss.GetLiveSession(ctx, ownerSessionID)
	if err != nil || own == nil {
		return false
	}
	board := ptr.Value(own.BoardName)
	return board != "" && board == ptr.Value(ls.BoardName)
}

// validateExactLiveTarget prevents name-based terminal APIs from selecting a
// sibling session. The route name is checked against metadata loaded by the
// supplied session ID; agentType is a consistency assertion, never a lookup key.
func (h *SessionsHandler) validateExactLiveTarget(ctx context.Context, name, agentType, sessionID string, terminalRoute bool) (*store.LiveSession, int, string) {
	if sessionID == "" || agentType == "" {
		return nil, http.StatusBadRequest, errSessionIDRequired
	}
	parsed, err := uuid.Parse(sessionID)
	if err != nil || parsed.String() != sessionID {
		return nil, http.StatusBadRequest, "invalid session_id"
	}
	ls, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil {
		slog.Warn("failed to validate live session metadata", "session_id", sessionID, "error", err)
		return nil, http.StatusServiceUnavailable, "Agent metadata is temporarily unavailable; try again."
	}
	if ls == nil {
		return nil, http.StatusNotFound, "live session not found"
	}
	var status string
	if err := h.db.Reader().GetContext(ctx, &status,
		"SELECT status FROM live_sessions WHERE session_id = ?", sessionID); err != nil {
		slog.Warn("failed to validate live session metadata", "session_id", sessionID, "error", err)
		return nil, http.StatusServiceUnavailable, "Agent metadata is temporarily unavailable; try again."
	}
	if status != "active" {
		return nil, http.StatusNotFound, "live session not found"
	}
	if ls.IsArchived == 1 {
		return nil, http.StatusConflict, "session is archived"
	}
	if ls.IsSleeping == 1 {
		return nil, http.StatusConflict, "session is sleeping"
	}
	expectedName := ls.AgentName
	if terminalRoute {
		expectedName = naming.SessionName(ls.AgentType, ls.SessionID)
	}
	nameMatches := name == expectedName
	if !terminalRoute {
		// Launch responses and existing API clients use the canonical terminal
		// name as the REST path, while the dashboard uses the stored agent name.
		// Both are unambiguous only after the exact type/ID tuple has matched.
		nameMatches = nameMatches || name == naming.SessionName(ls.AgentType, ls.SessionID)
	}
	if agentType != ls.AgentType || !nameMatches {
		return nil, http.StatusBadRequest, "session target mismatch"
	}
	return ls, 0, ""
}

// errSessionIDRequired is the message for a request that does not name its exact
// target. It answers 400 with code session_id_required, never 404: through the
// hub a 404 reads as a route refusal.
const errSessionIDRequired = "session_id and agent_type are required"

func writeExactTargetError(w http.ResponseWriter, status int, message string) {
	body := map[string]string{"error": message}
	if message == errSessionIDRequired {
		body["code"] = "session_id_required"
	}
	writeJSON(w, status, body)
}

// terminalGoneMessage is shown in the composer, prompt bar and keys (#3211).
const terminalGoneMessage = "The agent's terminal is gone"

// writeTerminalError answers a terminal write or action that failed: 409 terminal_gone when
// the agent's own terminal no longer exists (nothing was sent anywhere, #3211), else 500.
func writeTerminalError(w http.ResponseWriter, err error) {
	if errors.Is(err, ptymanager.ErrTerminalGone) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": terminalGoneMessage, "code": "terminal_gone", "not_sent": true})
		return
	}
	errInternalServer(w, err.Error())
}

// namesNoSession is true when a request has no session id and its name is not an exact
// "type-<uuid>" terminal name (which names one session; the terminal resolves it by id).
func namesNoSession(name, sessionID string) bool {
	if sessionID != "" {
		return false
	}
	_, sid := logparse.ParseSessionName(name)
	return sid == ""
}

// writeSessionIDRequired refuses a per-session request that names no session id: by bare
// name it would reach whichever terminal matches the name, another agent's included (#3211).
func writeSessionIDRequired(w http.ResponseWriter) {
	writeError( // (Callers check namesNoSession first: an exact "type-<uuid>" terminal name names one session.)
		w, http.StatusBadRequest, "session_id_required", "session_id is required")
}

func shouldValidateExactTarget(agentType, sessionID string) bool {
	return agentType != "" || sessionID != ""
}

// ResolveByPIDs looks up the agent identity for a set of process IDs: the caller's process
// and its ancestors, nearest first. Used by coral-board to identify itself when env vars are
// stripped (e.g. Codex sandbox).
// GET /api/sessions/resolve?pids=12345,12340,12335
func (h *SessionsHandler) ResolveByPIDs(w http.ResponseWriter, r *http.Request) {
	pidStr := r.URL.Query().Get("pids")
	if pidStr == "" {
		errBadRequest(w, "pids parameter required")
		return
	}
	var pids []int
	for _, s := range strings.Split(pidStr, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		pid, err := strconv.Atoi(s)
		if err != nil {
			continue
		}
		pids = append(pids, pid)
	}
	if len(pids) == 0 {
		errBadRequest(w, "no valid PIDs")
		return
	}
	rows, err := h.ss.LiveSessionsByPIDs(r.Context(), pids)
	var ls *store.LiveSession
	if err == nil {
		ls = h.verifiedSessionForPIDs(r.Context(), pids, rows)
	}
	if ls == nil {
		errNotFound(w, "no matching session")
		return
	}
	role := ""
	if ls.DisplayName != nil {
		role = *ls.DisplayName
	}
	boardName := ""
	if ls.BoardName != nil {
		boardName = *ls.BoardName
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"subscriber_id": naming.SubscriberID(role, ls.AgentType),
		"project":       boardName,
		"session_name":  naming.SessionName(ls.AgentType, ls.SessionID),
	})
}

// verifiedSessionForPIDs returns the session the caller runs in, or nil. pids are the
// caller's process and its ancestors, nearest first; rows are the active sessions whose
// recorded process is one of them. The first pid that is a session's process NOW, as its
// terminal backend reports it, names the session. A recorded pid that is no longer the
// session's process is skipped: the number may have been reused by anything, another
// agent's shell included, and trusting it handed that agent this session's board and role
// (#3864). Two sessions on one pid give no answer rather than a guess.
func (h *SessionsHandler) verifiedSessionForPIDs(ctx context.Context, pids []int, rows []store.LiveSession) *store.LiveSession {
	byPID := make(map[int][]*store.LiveSession, len(rows))
	for i := range rows {
		byPID[rows[i].PID] = append(byPID[rows[i].PID], &rows[i])
	}
	for _, pid := range pids {
		var live []*store.LiveSession
		for _, ls := range byPID[pid] {
			backend := ""
			if ls.Backend != nil {
				backend = *ls.Backend
			}
			now, err := launchedSessionPID(ctx, backend, h.backend, h.terminal, naming.SessionName(ls.AgentType, ls.SessionID))
			if err == nil && now == pid {
				live = append(live, ls)
			}
		}
		switch len(live) {
		case 0:
			continue
		case 1:
			return live[0]
		default:
			return nil
		}
	}
	return nil
}
