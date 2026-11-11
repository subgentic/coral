package routes

import (
	"net/http"
	"time"
)

// ContextResetLine is what the Context reset service knows about one agent (#15066): when it last compacted it and the context it had then, and its last line (what it typed, or why it did not).
type ContextResetLine struct {
	LastCompactedAt time.Time // zero when this process has not compacted it
	LastTokens      int
	Text            string // "typed at 14:02", "skipped: ..." or ""
	TextAt          time.Time
}

// SetContextResetStatus gives the board the Context reset service's per-agent line (background.ContextCompact).
func (h *BoardHandler) SetContextResetStatus(fn func(sessionName string) (ContextResetLine, bool)) {
	h.contextReset = fn
}

type contextResetAgent struct {
	SessionName     string `json:"session_name"`
	JobTitle        string `json:"job_title"`
	LastCompactedAt string `json:"last_compacted_at,omitempty"`
	LastTokens      int    `json:"last_tokens,omitempty"`
	Text            string `json:"text,omitempty"`
	TextAt          string `json:"text_at,omitempty"`
}

// GetContextResetStatus is the line Team settings shows under each agent: GET /api/board/{project}/context-reset-status
// returns {"agents": [{session_name, job_title, last_compacted_at, last_tokens, text, text_at}]}, one per active member.
// The times are RFC 3339 UTC and left out when there is none; the lines are kept in memory, so a restart empties them
// (the compaction itself is remembered). The Operator or the team's orchestrator only, never through Coral Hub.
func (h *BoardHandler) GetContextResetStatus(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	if _, ok := h.healthAdmin(r, project); !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can read the Context reset status")
		return
	}
	subs, err := h.bs.ListSubscribers(r.Context(), project)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	out := []contextResetAgent{}
	for _, s := range subs {
		if s.IsActive == 0 || s.SessionName == "" {
			continue
		}
		a := contextResetAgent{SessionName: s.SessionName, JobTitle: s.JobTitle}
		if h.contextReset != nil {
			if l, ok := h.contextReset(s.SessionName); ok {
				if !l.LastCompactedAt.IsZero() {
					a.LastCompactedAt = l.LastCompactedAt.UTC().Format(time.RFC3339)
					a.LastTokens = l.LastTokens
				}
				a.Text = l.Text
				if !l.TextAt.IsZero() {
					a.TextAt = l.TextAt.UTC().Format(time.RFC3339)
				}
			}
		}
		out = append(out, a)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"agents": out})
}
