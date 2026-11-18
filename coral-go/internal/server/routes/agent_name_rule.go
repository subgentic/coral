package routes

import (
	"context"
	"net/http"
	"strconv"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// A name is unique within a team, archived agents included (#19673, the Operator's rule, which "can change later": it lives only here). A launch or a join with the name of a member that is still on the team does
// not take that member's seat over (its tasks, mentions, read cursor and history); it is refused with 409 and the way on: an archived member can be Started (its history and tasks come back) or the launch can use
// another name; an awake or asleep one has its name taken.

const (
	nameArchivedCode = "name_archived"
	nameTakenCode    = "name_taken"
)

// memberNameConflict is the member of project whose name is name (case and spacing aside), as (code, member, its session id): "" when the name is free. exceptSessionName is the session asking: a member that
// joins again from its own session (a restart) is not in conflict with itself.
func (h *SessionsHandler) memberNameConflict(ctx context.Context, project, name, exceptSessionName string) (code string, sub *board.Subscriber, sessionID string) {
	if h.bs == nil || h.ss == nil || project == "" || name == "" || board.IsOperatorName(name) {
		return "", nil, ""
	}
	subs, err := h.bs.ListSubscribers(ctx, project)
	if err != nil {
		return "", nil, ""
	}
	for i := range subs {
		s := &subs[i]
		if !board.SameIdentity(s.SubscriberID, name) || s.SessionName == "" || s.SessionName == exceptSessionName {
			continue
		}
		sid := naming.SessionIDFromName(s.SessionName)
		ls, err := h.ss.GetLiveSession(ctx, sid)
		if err != nil || ls == nil {
			continue // a seat whose session row is gone is nobody's to protect
		}
		if memberIsArchived(ls) {
			return nameArchivedCode, s, sid
		}
		return nameTakenCode, s, sid
	}
	return "", nil, ""
}

// memberIsArchived: archived, or ended and not started again (Ended is Archived).
func memberIsArchived(ls *store.LiveSession) bool {
	return ls.IsArchived == 1 || (ls.Status == "inactive" && ls.StoppedAt != nil)
}

// freeMemberName is the first of "<name> 2", "<name> 3" ... that no member of the team has. (A name must end with a letter or a digit, so it is not "<name> (2)".)
func (h *SessionsHandler) freeMemberName(ctx context.Context, project, name string) string {
	subs, _ := h.bs.ListSubscribers(ctx, project)
	for n := 2; n < 1000; n++ {
		cand := name + " " + strconv.Itoa(n)
		free := true
		for _, s := range subs {
			if board.SameIdentity(s.SubscriberID, cand) {
				free = false
				break
			}
		}
		if free {
			return cand
		}
	}
	return name + " 1000"
}

// RefuseMemberName is refuseMemberName for the board handler's join route.
func (h *SessionsHandler) RefuseMemberName(w http.ResponseWriter, ctx context.Context, project, name, exceptSessionName string) bool {
	return h.refuseMemberName(w, ctx, project, name, exceptSessionName)
}

// refuseMemberName answers a launch or join whose name is a member's with 409 and the choices; true when it did.
func (h *SessionsHandler) refuseMemberName(w http.ResponseWriter, ctx context.Context, project, name, exceptSessionName string) bool {
	code, sub, sid := h.memberNameConflict(ctx, project, name, exceptSessionName)
	if code == "" {
		return false
	}
	member := orchName(sub.SubscriberID)
	body := map[string]any{"code": code, "member": member, "session_id": sid, "suggested_name": h.freeMemberName(ctx, project, sub.SubscriberID)}
	if code == nameArchivedCode {
		body["error"] = "an archived agent named " + member + " is on this team: Start it (its history and tasks come back) or use another name"
	} else {
		body["error"] = "an agent named " + member + " is already on this team: use another name"
		delete(body, "session_id")
	}
	body["message"] = body["error"]
	writeJSON(w, http.StatusConflict, body)
	return true
}
