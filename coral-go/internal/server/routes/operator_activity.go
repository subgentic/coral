package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The Activity record's routes and what feeds it (#12069). The record is the Operator's alone and local: GET /api/activity is not in the tunnel's table (so the Hub never reaches it), an agent has no route to
// it, and it is not in history search or the feed.

// activityMetaFor is who acted and from where, taken from the verified request and never from the body: local, or a Hub account by its stable id (an opaque label, never an email or a name). hint is what the
// page said about itself (X-Coral-Client: phone), kept only as "phone" and shown as reported by the page. note is the Operator's own words, redacted and cut here; if the redactor refuses the action is
// recorded with no note rather than the raw one.
func activityMetaFor(r *http.Request, title, note string) board.ActivityMeta {
	m := board.ActivityMeta{Actor: "local", Source: "local", Title: title}
	if cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		m.Source = "hub"
		m.Actor = activityActor(hubOwnerRequest(r)) // the one owner check (hub_owner.go): this file reads no stamp of its own
	}
	if r.Header.Get("X-Coral-Client") == "phone" {
		m.Hint = "phone"
	}
	if note != "" {
		if red, ok := redactComment(note); ok {
			m.Note = red
		}
	}
	return m
}

// activityActor is the label the record keeps for who acted: "local" at this computer, a Hub account by its stable id when the machine is a team's, else by a short hash of the label the stamp carried (never
// the label itself: not an email, not a name), and "hub:unknown" for a request that is not an authentic owner's.
func activityActor(id callerIdentity) string {
	switch {
	case id.local:
		return "local"
	case id.owner && id.hubUserID != "":
		return "hub:" + id.hubUserID
	case id.owner && id.pseudo != "":
		sum := sha256.Sum256([]byte(id.pseudo))
		return "hub:" + hex.EncodeToString(sum[:6])
	}
	return "hub:unknown"
}

// GET /api/activity?team=&action=&before=&limit= : the record, newest first, a page at a time, and whether its chain is whole (checked on the first page).
func (h *BoardHandler) ListActivity(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		commentRefuse(w, http.StatusForbidden, "not_through_hub", "the Activity record is on this computer only")
		return
	}
	if !operatorOnly(w, r) {
		return
	}
	q := r.URL.Query()
	team, action := q.Get("team"), q.Get("action")
	if team != "" && !commentBoardRe.MatchString(team) {
		errBadRequest(w, "invalid team")
		return
	}
	if action != "" && !activityActions[action] {
		errBadRequest(w, "unknown action")
		return
	}
	f := board.ActivityFilter{Team: team, Action: action}
	if v := q.Get("before"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			errBadRequest(w, "invalid before")
			return
		}
		f.BeforeID = n
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			errBadRequest(w, "invalid limit")
			return
		}
		f.Limit = n
	}
	rows, err := h.bs.ListActivity(r.Context(), f)
	if err != nil {
		errInternalServer(w, "could not read the record")
		return
	}
	out := map[string]any{"actions": rows}
	if f.BeforeID == 0 {
		chk, err := h.bs.VerifyActivity(r.Context())
		if err != nil {
			errInternalServer(w, "could not check the record")
			return
		}
		out["check"] = chk
	}
	if len(rows) > 0 {
		out["next_before"] = rows[len(rows)-1].ID
	}
	writeJSON(w, http.StatusOK, out)
}

var activityActions = map[string]bool{
	board.ActApprove: true, board.ActChanges: true, board.ActDeny: true, board.ActIgnore: true, board.ActUnignore: true, board.ActSave: true, board.ActUnsave: true, board.ActUndone: true,
	board.ActAnswer: true, board.ActDismiss: true, board.ActGoalDone: true, board.ActProposal: true, board.ActMarkRead: true, board.ActGoalReview: true,
}

// recordActivity adds the row of an Operator action that is not a write in the board database's own transaction (best effort: a crash between the action and its row can lose one row, and a row that cannot
// be written is logged and never blocks the action). Only the Operator's own actions are recorded: callers check who acted before they call.
func (h *BoardHandler) recordActivity(r *http.Request, action, kind, item, team, title, note string) {
	if h.bs == nil {
		return
	}
	_ = h.bs.RecordActivity(context.WithoutCancel(r.Context()), activityMetaFor(r, title, note), action, kind, item, "", team)
}
