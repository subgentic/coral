package routes

import (
	"context"
	"strings"

	setreg "github.com/subgentic/coral/internal/settings"
)

// chiefRestartMode is the permission mode a restart of session sid must use when sid is the agent the Operator recorded as Chief (the chief_page setting on and chief_session exactly this id), from
// the saved chief_actions (#11798); "" for any other agent, which restarts as it was. Those settings are the Operator's alone (an agent's token cannot write them), so an agent cannot name itself Chief.
func (h *SessionsHandler) chiefRestartMode(ctx context.Context, sid string) string {
	if sid == "" {
		return ""
	}
	st, err := h.ss.GetSettings(ctx)
	if err != nil || !setreg.Bool(st, "chief_page") || strings.TrimSpace(setreg.Text(st, "chief_session")) != sid {
		return ""
	}
	return setreg.ChiefPermissionMode(st)
}
