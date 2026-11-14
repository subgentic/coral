package routes

import (
	"slices"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/custommodes"
	"github.com/subgentic/coral/internal/store"
)

// launchTimeOf is when a live session's current run started (launched_at, else created_at), read in either of the formats the store writes; the zero time when it cannot be read.
func launchTimeOf(ls store.LiveSession) time.Time {
	s := launchedOf(ls)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// liveClaudeMode is the permission mode a Claude agent is in now when it differs from the one Coral stored, or "" when the stored one stands (#16523, the Operator's #16519: Shift+Tab inside
// Claude changes the live mode and Coral keeps the launch mode, so Reset team relaunched with the old one). Claude writes permissionMode on its user entries; the newest one is used when:
//   - the agent is Claude and its stored mode is not a custom mode (a custom mode's own flags are the launch's);
//   - that entry is newer than the run's start (launch, or Restart with changes: a mode set there, with no message since, is not undone by an older entry);
//   - it never escalates: bypassPermissions is taken only when the stored launch already allowed it (the stored mode, or --dangerously-skip-permissions or
//     --allow-dangerously-skip-permissions among its flags); any other value is one Coral can launch and asks at least as much as Shift+Tab already allowed in the terminal.
func (h *SessionsHandler) liveClaudeMode(ls store.LiveSession, storedMode string, flags []string) string {
	if ls.AgentType != at.Claude || h.jsonl == nil {
		return ""
	}
	if _, custom := custommodes.IDOf(storedMode); custom {
		return ""
	}
	mode, when := h.jsonl.ReadClaudePermissionMode(ls.SessionID, ls.WorkingDir)
	if mode == "" || mode == storedMode || !agent.ValidPermissionMode(mode) {
		return ""
	}
	started := launchTimeOf(ls)
	if started.IsZero() || !when.After(started) {
		return ""
	}
	if mode == "bypassPermissions" && storedMode != "bypassPermissions" &&
		!slices.Contains(flags, "--allow-dangerously-skip-permissions") && !slices.Contains(flags, "--dangerously-skip-permissions") {
		return ""
	}
	return mode
}
