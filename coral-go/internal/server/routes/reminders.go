package routes

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// Reminders for any agent (#19162, goal #249): Chief's checks (chief_checks.go) opened to every agent. A reminder is a check row with an origin (who set it) that is delivered to one agent, once or on a schedule, and stays open until
// the agent (or the person) resolves it. Chief's own checks are not reminders: their origin is "chief" and only the person at this computer sees or changes them.
//
// Who may set one: the person at this computer, for any live member of a team on it; an agent, for itself; the team's Orchestrator, for a member of its own team and only while the Orchestrator access grant is on. Never
// across teams, and never through the Hub (chiefLocal).

const (
	maxAgentReminders        = 20  // active reminders one agent may have set for itself
	maxOrchestratorReminders = 50  // active reminders an Orchestrator may have set on one team
	minSelfReminderMinutes   = 15  // an agent's own recurring reminder runs no faster than this
	maxReminderHorizonDays   = 364 // a one-time reminder is at most this far ahead: its yearly cron line (minute, day, month) then first matches on its own date, never earlier (365 and 366 days ahead match this year first, #19264)
)

func (h *ChiefChecksHandler) registerReminders(r chi.Router) {
	r.Get("/api/reminders", h.remindersList)
	r.Post("/api/reminders", h.remindersAdd)
	r.Get("/api/reminders/{reminderID}", h.remindersGet)
	r.Delete("/api/reminders/{reminderID}", h.remindersCancel)
	r.Post("/api/reminders/{reminderID}/done", h.remindersDone)
}

// reminderCaller is who is asking: the person, or an agent's verified session.
type reminderCaller struct {
	person    bool
	sessionID string
	board     string // the agent's own board
	title     string // the agent's own name on it
}

func (h *ChiefChecksHandler) reminderCaller(w http.ResponseWriter, r *http.Request) (reminderCaller, bool) {
	if !chiefLocal(w, r) {
		return reminderCaller{}, false
	}
	owner, agent := VerifiedSession(r.Context())
	if !agent {
		if !humanInputCaller(r) {
			commentRefuse(w, 403, "forbidden", "only the person at this computer or an agent in its own session can use reminders")
			return reminderCaller{}, false
		}
		return reminderCaller{person: true}, true
	}
	ls, err := h.sessions.ss.GetLiveSession(r.Context(), owner.SessionID)
	if err != nil || ls == nil || ls.IsArchived != 0 || ls.BoardName == nil || *ls.BoardName == "" {
		commentRefuse(w, 403, "not_on_a_board", "reminders are for an agent that is a member of a team")
		return reminderCaller{}, false
	}
	c := reminderCaller{sessionID: owner.SessionID, board: *ls.BoardName}
	if _, sub, err := h.target(r.Context(), c.board, c.sessionID); err == nil {
		c.title = clitext.Clean(sub.JobTitle)
	}
	return c, true
}

// isSeat is whether the caller is the Orchestrator seat of the board while the Orchestrator access grant is on: the one case where an agent may set or manage a reminder for another member.
func (h *ChiefChecksHandler) isSeat(ctx context.Context, c reminderCaller, boardName string) bool {
	if c.person || c.board != boardName {
		return false
	}
	g, err := h.sessions.bs.GetOrchGrant(ctx, boardName)
	return err == nil && g.Enabled && g.SeatSession == c.sessionID
}

// mayManage is whether the caller may see, resolve or cancel this reminder: the person (any), the agent it is for, or the team's seat.
func (h *ChiefChecksHandler) mayManage(ctx context.Context, c reminderCaller, ch *store.ChiefCheck) bool {
	if !ch.IsReminder() {
		return c.person // Chief's own checks are the person's alone
	}
	return c.person || c.sessionID == ch.TargetSession || h.isSeat(ctx, c, ch.TargetBoard)
}

// mayCancel is who may remove a reminder: the person, the team's seat, or the agent that set it for itself (origin agent). An agent may mark done any reminder for it, but cancels only its own (#19245).
func (h *ChiefChecksHandler) mayCancel(ctx context.Context, c reminderCaller, ch *store.ChiefCheck) bool {
	if c.person || h.isSeat(ctx, c, ch.TargetBoard) {
		return true
	}
	return ch.Origin == "agent" && c.sessionID == ch.TargetSession
}

type reminderBody struct {
	Text         string `json:"text"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`          // once, every, daily or weekdays
	At           string `json:"at"`            // once: YYYY-MM-DDTHH:mm in timezone; daily and weekdays: HH:mm
	EveryMinutes int    `json:"every_minutes"` // every: 5, 15, 30 or 60
	Timezone     string `json:"timezone"`      // an IANA zone name
	To           string `json:"to"`            // a member's name; empty: the caller (an agent)
	Board        string `json:"board"`         // the target's team; empty: the caller's own
	NoWake       bool   `json:"no_wake"`       // do not wake the agent if it is asleep
}

// reminderView is a reminder as the API says it: the check and where its latest trigger stands.
type reminderView struct {
	store.ChiefCheck
	TargetName string `json:"target_name"`
	State      string `json:"state"` // "open" (delivered or waiting to be, not yet resolved), "done", "none" (no trigger yet) or "off" (a one-time reminder that has fired and was resolved, or a cancelled one)
	TriggerID  int64  `json:"trigger_id,omitempty"`
	Delivery   string `json:"delivery,omitempty"`
}

func (h *ChiefChecksHandler) viewOf(ctx context.Context, ch store.ChiefCheck) reminderView {
	v := reminderView{ChiefCheck: ch, State: "none"}
	if _, sub, err := h.target(ctx, ch.TargetBoard, ch.TargetSession); err == nil {
		v.TargetName = clitext.Clean(sub.JobTitle)
	}
	if ts, err := h.sched.ChiefTriggers(ctx, ch.ID, 0, ""); err == nil && len(ts) > 0 {
		v.State, v.TriggerID, v.Delivery = ts[0].State, ts[0].ID, ts[0].Delivery
		if v.State == "routed" || v.State == "waiting_on_operator" {
			v.State = "open"
		}
	}
	return v
}

func (h *ChiefChecksHandler) remindersList(w http.ResponseWriter, r *http.Request) {
	c, ok := h.reminderCaller(w, r)
	if !ok {
		return
	}
	checks, err := h.sched.ChiefChecks(r.Context())
	if err != nil {
		errInternalServer(w, "could not read the reminders")
		return
	}
	team := r.URL.Query().Get("team") == "1"
	out := []reminderView{}
	for i := range checks {
		ch := checks[i]
		if !ch.IsReminder() || !h.mayManage(r.Context(), c, &ch) {
			continue
		}
		if !c.person && !team && ch.TargetSession != c.sessionID {
			continue // an agent's list is its own unless it asks for its team's (a seat only)
		}
		out = append(out, h.viewOf(r.Context(), ch))
	}
	writeJSON(w, 200, map[string]any{"reminders": out})
}

func (h *ChiefChecksHandler) remindersGet(w http.ResponseWriter, r *http.Request) {
	c, ok := h.reminderCaller(w, r)
	if !ok {
		return
	}
	id, ok := chiefID(w, r, "reminderID")
	if !ok {
		return
	}
	ch, err := h.sched.ChiefCheck(r.Context(), id)
	if err != nil || ch.Deleted || !ch.IsReminder() || !h.mayManage(r.Context(), c, ch) {
		errNotFound(w, "reminder not found") // one answer for a missing one and one that is not the caller's
		return
	}
	writeJSON(w, 200, h.viewOf(r.Context(), *ch))
}

// targetOf resolves who the reminder is for and the origin it carries; a refusal is written and ok is false.
func (h *ChiefChecksHandler) targetOf(w http.ResponseWriter, r *http.Request, c reminderCaller, b reminderBody) (boardName, sessionID, origin, by string, ok bool) {
	ctx := r.Context()
	if c.person {
		boardName = strings.TrimSpace(b.Board)
		if boardName == "" || strings.TrimSpace(b.To) == "" {
			errBadRequest(w, "name the team (board) and the member (to) the reminder is for")
			return
		}
		origin, by = "operator", "the Operator"
	} else {
		boardName = c.board
		if b.Board != "" && b.Board != c.board {
			commentRefuse(w, 403, "other_team", "a reminder can only be set on your own team")
			return
		}
		origin, by = "agent", c.title
	}
	to := strings.TrimSpace(b.To)
	if to == "" { // an agent's own
		sessionID = c.sessionID
		if sessionID == "" {
			errBadRequest(w, "name the member (to) the reminder is for")
			return
		}
	} else {
		subs, err := h.sessions.bs.ListSubscribers(ctx, boardName)
		if err != nil {
			errInternalServer(w, "could not read the team")
			return
		}
		for _, s := range subs {
			if s.IsActive != 0 && (strings.EqualFold(s.SubscriberID, to) || strings.EqualFold(strings.TrimSpace(s.JobTitle), to)) {
				sessionID = naming.SessionIDFromName(s.SessionName)
				break
			}
		}
		if sessionID == "" {
			commentRefuse(w, 400, "invalid_target", "choose a live member of that team; the reminder was not saved")
			return
		}
		if !c.person && sessionID != c.sessionID {
			if !h.isSeat(ctx, c, boardName) {
				commentRefuse(w, 403, "not_the_orchestrator", "an agent can set a reminder for itself; only the team's Orchestrator, while the Orchestrator access setting is on, can set one for another member")
				return
			}
			origin = "orchestrator"
		}
	}
	if _, _, err := h.target(ctx, boardName, sessionID); err != nil {
		commentRefuse(w, 400, "invalid_target", "choose a live member of that team; the reminder was not saved")
		return
	}
	by = strings.TrimSpace(clitext.Clean(by)) // a name is cleaned once, at write, so no row carries control characters (#19245)
	if by == "" {
		by = "an agent"
	}
	ok = true
	return
}

func (h *ChiefChecksHandler) remindersAdd(w http.ResponseWriter, r *http.Request) {
	c, ok := h.reminderCaller(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 14<<10)
	var b reminderBody
	if err := decodeJSONStrict(r, &b); err != nil {
		errBadRequest(w, "send the reminder as JSON: text, kind, at or every_minutes, timezone, to")
		return
	}
	b.Text = strings.TrimSpace(clitext.Clean(b.Text))
	if b.Text == "" {
		errBadRequest(w, "text is required")
		return
	}
	if hasSignInLink(b.Text + "\n" + b.Name) {
		writeError(w, 400, "sign_in_link", signInLinkRefusal)
		return
	}
	safe, ok := redactChiefText(b.Text + "\n" + b.Name)
	if !ok {
		commentRefuse(w, 503, "secret_check_unavailable", "the text could not be checked; nothing was saved")
		return
	}
	if safe != b.Text+"\n"+b.Name {
		commentRefuse(w, 400, "secret_not_saved", "remove the secret from the reminder; it was not saved")
		return
	}
	boardName, sessionID, origin, by, ok := h.targetOf(w, r, c, b)
	if !ok {
		return
	}
	name := strings.TrimSpace(clitext.Clean(b.Name))
	if name == "" {
		name = strings.Join(strings.Fields(b.Text), " ")
		if utf8.RuneCountInString(name) > 60 {
			name = string([]rune(name)[:60])
		}
	}
	check := store.ChiefCheck{Name: name, Instruction: b.Text, TargetBoard: boardName, TargetSession: sessionID, NotifyMode: "every_time",
		WakeIfAsleep: !b.NoWake, Enabled: true, Timezone: strings.TrimSpace(b.Timezone), Origin: origin, CreatedBy: by}
	now := h.now()
	switch b.Kind {
	case "once":
		check.ScheduleKind, check.At = "once", b.At
	case "every":
		check.ScheduleKind, check.EveryMinutes = "interval", b.EveryMinutes
	case "daily", "weekdays":
		check.ScheduleKind, check.At = b.Kind, b.At
	default:
		errBadRequest(w, "kind must be once, every, daily or weekdays")
		return
	}
	if _, err := store.ChiefCron(check); err != nil {
		errBadRequest(w, err.Error())
		return
	}
	if check.ScheduleKind == "once" {
		loc, _ := time.LoadLocation(check.Timezone)
		at, _ := time.ParseInLocation("2006-01-02T15:04", check.At, loc)
		if at.Before(now.Truncate(time.Minute)) {
			errBadRequest(w, "that time has passed")
			return
		}
		if at.After(now.AddDate(0, 0, maxReminderHorizonDays)) {
			errBadRequest(w, "a reminder can be at most 364 days ahead")
			return
		}
	}
	if origin != "operator" && check.ScheduleKind == "interval" && check.EveryMinutes < minSelfReminderMinutes {
		errBadRequest(w, "an agent's reminder can repeat at most every 15 minutes")
		return
	}
	h.mu.Lock() // the limit check and the save are one step, so two requests at once cannot both pass the cap (#19245)
	defer h.mu.Unlock()
	if msg := h.overLimit(r.Context(), origin, boardName, sessionID); msg != "" {
		commentRefuse(w, 409, "too_many_reminders", msg)
		return
	}
	saved, err := h.sched.SaveChiefCheck(r.Context(), check)
	if err != nil {
		chiefError(w, err)
		return
	}
	writeJSON(w, 201, h.viewOf(r.Context(), *saved))
}

// overLimit says why one more reminder is refused ("" when it is not): an agent's own are capped, and so are an Orchestrator's on one team.
func (h *ChiefChecksHandler) overLimit(ctx context.Context, origin, boardName, sessionID string) string {
	checks, err := h.sched.ChiefChecks(ctx)
	if err != nil {
		return ""
	}
	own, team := 0, 0
	for _, ch := range checks {
		if !ch.Enabled || ch.Origin != origin {
			continue
		}
		if origin == "agent" && ch.TargetSession == sessionID {
			own++
		}
		if origin == "orchestrator" && ch.TargetBoard == boardName {
			team++
		}
	}
	if origin == "agent" && own >= maxAgentReminders {
		return "you already have 20 active reminders; cancel one first"
	}
	if origin == "orchestrator" && team >= maxOrchestratorReminders {
		return "this team already has 50 active reminders set by its Orchestrator; cancel one first"
	}
	return ""
}

func (h *ChiefChecksHandler) remindersCancel(w http.ResponseWriter, r *http.Request) {
	c, ok := h.reminderCaller(w, r)
	if !ok {
		return
	}
	id, ok := chiefID(w, r, "reminderID")
	if !ok {
		return
	}
	ch, err := h.sched.ChiefCheck(r.Context(), id)
	if err != nil || ch.Deleted || !ch.IsReminder() || !h.mayManage(r.Context(), c, ch) {
		errNotFound(w, "reminder not found")
		return
	}
	if !h.mayCancel(r.Context(), c, ch) {
		commentRefuse(w, 403, "not_yours_to_cancel", "this reminder was set by the Operator or the team's Orchestrator: mark it done with 'remind done', and they cancel it")
		return
	}
	if err := h.sched.DeleteChiefCheck(r.Context(), id, ch.Revision); err != nil {
		chiefError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// remindersDone resolves a reminder's open trigger: the agent says it is done (or the person, or the team's seat, does). A reminder with nothing open is a plain answer, not an error.
func (h *ChiefChecksHandler) remindersDone(w http.ResponseWriter, r *http.Request) {
	c, ok := h.reminderCaller(w, r)
	if !ok {
		return
	}
	id, ok := chiefID(w, r, "reminderID")
	if !ok {
		return
	}
	ch, err := h.sched.ChiefCheck(r.Context(), id)
	if err != nil || ch.Deleted || !ch.IsReminder() || !h.mayManage(r.Context(), c, ch) {
		errNotFound(w, "reminder not found")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	open, err := h.sched.ChiefTriggers(r.Context(), id, 0, "open")
	if err != nil {
		errInternalServer(w, "could not read the reminder")
		return
	}
	if len(open) == 0 {
		writeJSON(w, 200, map[string]any{"ok": true, "resolved": false, "note": "nothing is open for this reminder"})
		return
	}
	if err := h.sched.SetChiefTriggerResolution(r.Context(), open[0].ID, "done", h.now()); err != nil {
		chiefStateError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "resolved": true, "trigger_id": open[0].ID})
}

// reminderSetter is how a reminder's notice names who set it, for the agent that gets it: its own, the Operator's, or its Orchestrator's.
func reminderSetter(ch *store.ChiefCheck, names []string) string {
	switch ch.Origin {
	case "agent":
		return "you"
	case "orchestrator":
		who := board.DefuseMentions(strings.Join(strings.Fields(clitext.Clean(ch.CreatedBy)), " "), names)
		if who == "" {
			who = "the Orchestrator"
		}
		return "the team's Orchestrator (" + who + ")"
	default:
		return "the Operator"
	}
}
