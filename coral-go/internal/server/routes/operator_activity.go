package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The Activity record's routes and what feeds it (#12069). The record is the Operator's alone: GET /api/activity is read only, an owner route in the tunnel's table (the Hub OWNER reads it, #12070), an agent
// has no route to it, and it is not in history search or the feed.

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
	m.Surface = surfaceOf(r)
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

// GET /api/activity?team=&action=&before=&limit= : the record, newest first, a page at a time, and whether its chain is whole (checked on the first page). Read only; the Operator's alone, at this computer or through
// Coral Hub as the Hub OWNER (#12070: the tunnel's table lists it as an owner route; nobody else gets it).
func (h *BoardHandler) ListActivity(w http.ResponseWriter, r *http.Request) {
	if !operatorOnly(w, r) { // at this computer, the person; through Coral Hub, the account this computer is linked to and nobody else (refuseNonOwner): a guest, a grantee or a viewer is refused owner_only
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
	// On a computer enrolled to a Coral Hub team each owner reads only the rows where they are the actor (by their stable id), the Operator's choice (#12070): the computer's own person, at the computer, reads all
	// of them, and so does the one owner of a personal machine. What the record says of the others is not in the answer: not their rows, not their count, not the id of a row that broke.
	scoped := ""
	if cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		if id := hubOwnerRequest(r); id.team {
			scoped = activityActor(id)
			f.Actor = scoped
		}
	}
	if v := q.Get("before"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			errBadRequest(w, "invalid before")
			return
		}
		f.BeforeID = n
	}
	if v := q.Get("before_at"); v != "" { // the cursor's time, with before: the page after the row (before_at, before)
		if _, err := time.Parse(time.RFC3339Nano, v); err != nil || f.BeforeID == 0 {
			errBadRequest(w, "before_at is a UTC time and goes with before")
			return
		}
		f.BeforeAt = v
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			errBadRequest(w, "invalid limit")
			return
		}
		f.Limit = n // more than board.ActivityMaxLimit is cut to it
	}
	rows, more, err := h.bs.ActivityPage(r.Context(), f)
	if err != nil {
		errInternalServer(w, "could not read the record")
		return
	}
	recordID, err := h.bs.ActivityRecordID(r.Context())
	if err != nil {
		errInternalServer(w, "could not read the record")
		return
	}
	out := map[string]any{"actions": rows, "more": more, "record_id": recordID, "limit_max": board.ActivityMaxLimit}
	if f.BeforeID == 0 {
		chk, err := h.bs.VerifyActivity(r.Context())
		if err != nil {
			errInternalServer(w, "could not check the record")
			return
		}
		if scoped != "" { // the chain is checked whole; what a team's owner is told of it is theirs alone
			n, err := h.bs.CountActivityBy(r.Context(), scoped)
			if err != nil {
				errInternalServer(w, "could not check the record")
				return
			}
			chk.Rows, chk.FirstBad = n, 0
		}
		out["check"] = chk
	}
	if len(rows) > 0 {
		last := rows[len(rows)-1]
		out["next_before"], out["next_before_at"] = last.ID, last.At
	}
	writeJSON(w, http.StatusOK, out)
}

var activityActions = map[string]bool{
	board.ActApprove: true, board.ActChanges: true, board.ActDeny: true, board.ActIgnore: true, board.ActSupersede: true, board.ActUnignore: true, board.ActSave: true, board.ActUnsave: true, board.ActUndone: true,
	board.ActAnswer: true, board.ActDismiss: true, board.ActGoalDone: true, board.ActProposal: true, board.ActMarkRead: true, board.ActGoalReview: true, board.ActSendReview: true, board.ActUnsendReview: true, board.ActHubUpdateCheck: true, board.ActHubUpdateRelaunch: true,
	board.ActSkillApprove: true, board.ActSkillReject: true, board.ActSkillRemove: true, board.ActSkillImport: true, board.ActSkillScriptsAck: true, board.ActSkillSecretAck: true,
}

// recordActivity adds the row of an Operator action that is not a write in the board database's own transaction (best effort: a crash between the action and its row can lose one row, and a row that cannot
// be written is logged and never blocks the action). Only the Operator's own actions are recorded: callers check who acted before they call.
func (h *BoardHandler) recordActivity(r *http.Request, action, kind, item, team, title, note string) {
	if h.bs == nil {
		return
	}
	ctx := context.WithoutCancel(r.Context())
	_ = h.bs.RecordActivity(ctx, activityMetaFor(r, title, note), action, kind, item, "", team)
	h.tellChief(ctx, action, kind, team, title, "") // the Operator's decision on a team Chief fronts (#12171)
}

// surfaceOf is which part of the page a person-only request came from, as the page says (X-Coral-Surface: inbox or chat), or "". It is read only on the routes that record the Operator's own actions (every one of
// them checks the caller is the person first), never from a body and never on an agent's call; anything but the two words is nothing (#12158).
func surfaceOf(r *http.Request) string {
	return board.ValidSurface(r.Header.Get("X-Coral-Surface"))
}
