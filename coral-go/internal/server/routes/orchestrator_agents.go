package routes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// The Operator's grant to a board's Orchestrator (#11432): a switch, off by default, that lets ONE session, the seat the Operator names, wake and sleep the agents seated on its own board and launch onto it,
// within caps, with every action logged and said on the board. Wake and sleep are two narrow routes of their own (the session routes stay the Operator's: every audit relies on that); they take no body at all.
//
//	GET|PUT /api/board/{project}/orchestrator-grant   the switch, the seat and the caps: the Operator's alone, the owner's through the Hub
//	GET     /api/board/{project}/lifecycle-log        what agents did to the board's agents
//	POST    /api/board/{project}/agents/{subscriber}/wake|sleep   the seat's, agent-only and local (refused through the Hub and for a sign-in link)
//
// The seat is a session the Operator picked, checked on EVERY request against the verified token's session and its live row; never a member whose job title says "orchestrator" (a title is chosen by whoever
// subscribes), never a name or session a caller supplies.

// operatorWrites: the Operator, as the identity layer verified it (the dashboard, the signed command line, an API key, or the Hub operator the tunnel's guard admitted); never a token, never a claim in a body.
func operatorWrites(w http.ResponseWriter, r *http.Request, what string) bool {
	if callerActor(r).IsOperator() {
		return true
	}
	writeError(w, http.StatusForbidden, "operator_only", "only the Operator can "+what)
	return false
}

type orchGrantBody struct {
	Enabled     bool   `json:"enabled"`
	SeatSession string `json:"seat_session"`
	MaxPerHour  int    `json:"max_per_hour"`
	MaxLive     int    `json:"max_live"`
	IdleMinutes int    `json:"idle_minutes"`
}

// OrchestratorGrant answers GET and PUT /api/board/{project}/orchestrator-grant.
func (h *SessionsHandler) OrchestratorGrant(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	project := chi.URLParam(r, "project")
	if r.Method == http.MethodGet {
		if !operatorWrites(w, r, "read what a board's orchestrator may do") {
			return
		}
		g, err := h.bs.GetOrchGrant(r.Context(), project)
		if err != nil {
			errInternalServer(w, "could not read the grant")
			return
		}
		writeJSON(w, http.StatusOK, g)
		return
	}
	if !operatorWrites(w, r, "change what a board's orchestrator may do") {
		return
	}
	var body orchGrantBody
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	cur, err := h.bs.GetOrchGrant(r.Context(), project)
	if err != nil {
		errInternalServer(w, "could not read the grant")
		return
	}
	g := board.OrchGrant{Project: project, Enabled: body.Enabled, SeatSession: strings.TrimSpace(body.SeatSession), MaxPerHour: body.MaxPerHour, MaxLive: body.MaxLive, IdleMin: body.IdleMinutes}
	if g.MaxPerHour == 0 {
		g.MaxPerHour = cur.MaxPerHour
	}
	if g.MaxLive == 0 {
		g.MaxLive = cur.MaxLive
	}
	if g.IdleMin == 0 {
		g.IdleMin = cur.IdleMin
	}
	if g.Enabled {
		// the seat must be a live session of THIS board that is not a terminal and not archived: the Operator picks it from the board's own agents
		sess, err := h.ss.GetLiveSession(r.Context(), g.SeatSession)
		if err != nil || sess == nil || ptr.Value(sess.BoardName) != project || sess.IsArchived == 1 || sess.AgentType == at.Terminal {
			errBadRequest(w, "seat_session must be a live agent seated on this board")
			return
		}
	}
	if err := h.bs.SetOrchGrant(r.Context(), g, "Operator"); err != nil {
		if errors.Is(err, board.ErrOrchGrantInvalid) {
			errBadRequest(w, err.Error())
			return
		}
		errInternalServer(w, "could not save the grant")
		return
	}
	if cur.Enabled != g.Enabled || cur.SeatSession != g.SeatSession || cur.MaxPerHour != g.MaxPerHour || cur.MaxLive != g.MaxLive || cur.IdleMin != g.IdleMin {
		if id, err := h.bs.ReserveLifecycle(r.Context(), project, "grant", "Operator", h.orchGrantWords(r.Context(), g), nil); err == nil {
			_ = h.bs.FinishLifecycle(r.Context(), id, "ok", "")
		}
	}
	saved, _ := h.bs.GetOrchGrant(r.Context(), project)
	writeJSON(w, http.StatusOK, saved)
}

// orchGrantWords is what the log row says of a change: the switch, the seat's name on the board (cleaned) and the caps, so the log shows who could act and how far.
func (h *SessionsHandler) orchGrantWords(ctx context.Context, g board.OrchGrant) string {
	words := "switch off"
	if g.Enabled {
		words = "switch on"
	}
	if g.SeatSession != "" {
		seat := "a session that is gone"
		if sess, err := h.ss.GetLiveSession(ctx, g.SeatSession); err == nil && sess != nil {
			seat = h.orchActor(sess)
		}
		words += ", seat " + seat
	}
	return words + fmt.Sprintf(", %d an hour, %d live, idle %d min", g.MaxPerHour, g.MaxLive, g.IdleMin)
}

// LifecycleLog answers GET /api/board/{project}/lifecycle-log.
func (h *SessionsHandler) LifecycleLog(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	if !operatorWrites(w, r, "read what agents did to a board's agents") {
		return
	}
	rows, err := h.bs.LifecycleLog(r.Context(), chi.URLParam(r, "project"), 100)
	if err != nil {
		errInternalServer(w, "could not read the log")
		return
	}
	if rows == nil {
		rows = []board.LifecycleEntry{}
	}
	writeJSON(w, http.StatusOK, rows)
}

// orchRefusal writes a refusal with a code a caller can match on.
func orchRefusal(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": msg, "message": msg, "code": code})
}

// orchSeat is who the request is as the board's orchestrator, re-resolved from the records on every request: the verified token's session must be the session the Operator named, its live row must be on
// this board, and the grant must be on. It answers the refusal itself.
func (h *SessionsHandler) orchSeat(w http.ResponseWriter, r *http.Request, project string) (board.OrchGrant, *store.LiveSession, bool) {
	owner, ok := VerifiedSession(r.Context())
	if !ok {
		orchRefusal(w, http.StatusForbidden, "agent_only", "this is an agent's request: it needs an agent session's token")
		return board.OrchGrant{}, nil, false
	}
	g, err := h.bs.GetOrchGrant(r.Context(), project)
	if err != nil {
		errInternalServer(w, "could not read the grant")
		return g, nil, false
	}
	if !g.Enabled {
		orchRefusal(w, http.StatusForbidden, "orchestrator_switch_off", "the Operator has not allowed this board's orchestrator to wake, sleep or start agents")
		return g, nil, false
	}
	if g.SeatSession == "" || owner.SessionID != g.SeatSession {
		orchRefusal(w, http.StatusForbidden, "not_the_seat", "only the orchestrator seat the Operator named may do this")
		return g, nil, false
	}
	sess, err := h.ss.GetLiveSession(r.Context(), owner.SessionID)
	if err != nil || sess == nil || ptr.Value(sess.BoardName) != project || sess.IsArchived == 1 {
		orchRefusal(w, http.StatusForbidden, "not_the_seat", "the seat's session is not on this board")
		return g, nil, false
	}
	if h.boardHandler != nil && h.boardHandler.IsPaused(project) {
		orchRefusal(w, http.StatusConflict, "board_paused", "the board is paused: nothing is woken, put to sleep or started until it is resumed")
		return g, nil, false
	}
	return g, sess, true
}

// orchTarget resolves the agent to act on from the BOARD'S OWN seats, by member, never from a session name the caller supplies, and refuses what is not a plain agent of this board.
func (h *SessionsHandler) orchTarget(w http.ResponseWriter, r *http.Request, project string, seat *store.LiveSession) (*store.LiveSession, string, bool) {
	member := strings.TrimSpace(chi.URLParam(r, "subscriber"))
	if member == "" || strings.EqualFold(member, "Operator") {
		orchRefusal(w, http.StatusBadRequest, "bad_target", "name an agent of this board")
		return nil, "", false
	}
	sub, err := h.bs.GetProjectSubscription(r.Context(), project, member)
	if err != nil || sub == nil || sub.SessionName == "" {
		orchRefusal(w, http.StatusNotFound, "no_such_agent", "no agent of this board has that name")
		return nil, "", false
	}
	sid := naming.SessionIDFromName(sub.SessionName)
	target, err := h.ss.GetLiveSession(r.Context(), sid)
	switch {
	case err != nil || target == nil || ptr.Value(target.BoardName) != project:
		orchRefusal(w, http.StatusNotFound, "no_such_agent", "that agent is not seated on this board")
	case target.SessionID == seat.SessionID:
		orchRefusal(w, http.StatusForbidden, "not_itself", "the orchestrator seat cannot wake or sleep itself")
	case target.AgentType == at.Terminal:
		orchRefusal(w, http.StatusForbidden, "not_an_agent", "a terminal is not an agent")
	case target.IsArchived == 1:
		orchRefusal(w, http.StatusConflict, "archived", "that agent is archived")
	default:
		return target, sub.SubscriberID, true
	}
	return nil, "", false
}

// orchName is a member name as the log and the board line carry it: data, cleaned and cut.
func orchName(s string) string {
	s = strings.ReplaceAll(clitext.CleanName(s), "@", "") // a name in the log or on the board can never mention anyone
	if r := []rune(s); len(r) > 60 {
		s = string(r[:60])
	}
	return s
}

// OrchestratorWake: POST /api/board/{project}/agents/{subscriber}/wake. No body is read.
func (h *SessionsHandler) OrchestratorWake(w http.ResponseWriter, r *http.Request) {
	project := chi.URLParam(r, "project")
	g, seat, ok := h.orchSeat(w, r, project)
	if !ok {
		return
	}
	target, member, ok := h.orchTarget(w, r, project, seat)
	if !ok {
		return
	}
	if target.IsSleeping != 1 {
		orchRefusal(w, http.StatusConflict, "not_asleep", "that agent is not asleep")
		return
	}
	actor, who := h.orchActor(seat), orchName(member)
	id, err := h.reserveForBoard(r.Context(), project, board.LifecycleWake, actor, who, g)
	if err != nil {
		h.refuseCap(w, err, g)
		return
	}
	ctx, cancel := lifecycleCtx(r.Context())
	defer cancel()
	if err := h.wakeExistingSession(ctx, target); err != nil {
		slog.Warn("orchestrator wake failed", "board", project, "error", err)
		_ = h.bs.FinishLifecycle(r.Context(), id, "failed", "the wake failed")
		orchRefusal(w, http.StatusBadGateway, "wake_failed", "Coral could not wake that agent")
		return
	}
	_ = h.bs.FinishLifecycle(r.Context(), id, "ok", "")
	h.sayLifecycle(r.Context(), project, actor+" woke "+who)
	h.tellWoken(r.Context(), project, member)
	h.kickWS()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "woke": who})
}

// OrchestratorWakeNotice is the ONE line a woken agent is given by Coral, never any text of the caller's: a resumed agent re-ran its last step (a runaway test) twice, so it is told to read the board first.
const OrchestratorWakeNotice = "[Coral] Woken by the Orchestrator: read the board before resuming any earlier command."

// tellWoken addresses the fixed wake line to the woken agent on the board; the notifier delivers it through the normal notice gate (held while a prompt is open, never typed over a draft).
func (h *SessionsHandler) tellWoken(ctx context.Context, project, member string) {
	if _, err := h.bs.PostSystemMessage(ctx, project, board.CoralSender, "@"+orchName(member)+" "+OrchestratorWakeNotice, nil); err != nil {
		slog.Warn("wake line not posted", "board", project, "error", err)
	}
}

// OrchestratorSleep: POST /api/board/{project}/agents/{subscriber}/sleep. No body is read.
func (h *SessionsHandler) OrchestratorSleep(w http.ResponseWriter, r *http.Request) {
	project := chi.URLParam(r, "project")
	g, seat, ok := h.orchSeat(w, r, project)
	if !ok {
		return
	}
	target, member, ok := h.orchTarget(w, r, project, seat)
	if !ok {
		return
	}
	if target.IsSleeping == 1 {
		orchRefusal(w, http.StatusConflict, "already_asleep", "that agent is already asleep")
		return
	}
	if code, why := h.refuseSleepNow(r.Context(), project, target, member, g); code != "" {
		orchRefusal(w, http.StatusConflict, code, why)
		return
	}
	actor, who := h.orchActor(seat), orchName(member)
	id, err := h.bs.ReserveLifecycle(r.Context(), project, board.LifecycleSleep, actor, who, nil)
	if err != nil {
		errInternalServer(w, "could not write the log")
		return
	}
	h.sleepNow(r.Context(), target)
	_ = h.bs.FinishLifecycle(r.Context(), id, "ok", "")
	h.sayLifecycle(r.Context(), project, actor+" put "+who+" to sleep")
	h.kickWS()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "slept": who})
}

// refuseSleepNow says why an agent must not be put to sleep now: it waits on the person (a permission prompt, a question, an ask to the Operator: that is theirs to answer), or it is working and has not been
// idle for the grant's minutes. "" when it may be.
func (h *SessionsHandler) refuseSleepNow(ctx context.Context, project string, target *store.LiveSession, member string, g board.OrchGrant) (code, why string) {
	st := h.deriveSingleSessionState(ctx, target.SessionID, 0)
	if st.NeedsInput {
		return "waiting_for_the_person", "that agent waits for the person's answer (a permission prompt or a question): leave it"
	}
	if skip, ok := ptymanager.SkippedOf(naming.SessionName(target.AgentType, target.SessionID)); ok && strings.HasPrefix(skip.Why, ptymanager.SkipPrompt) {
		return "at_a_dialog", "that agent is at a dialog at its terminal: sleeping it would hide a stuck prompt, so answer it or leave it where the Operator can see it"
	}
	if qs, err := h.bs.ListOperatorQuestions(ctx, project); err == nil {
		for _, q := range qs {
			if strings.EqualFold(q.SubscriberID, member) {
				return "waiting_for_the_person", "that agent waits for the Operator's reply: leave it"
			}
		}
	}
	if asks, err := h.bs.OpenAsks(ctx, project, time.Now()); err == nil {
		for _, a := range asks {
			if strings.EqualFold(a.Member, "Operator") && strings.EqualFold(a.Asker, member) {
				return "waiting_for_the_person", "that agent has asked the Operator a question that is not answered yet: leave it"
			}
		}
	}
	if st.InTurn || st.Working {
		idle := time.Duration(g.IdleMin) * time.Minute
		if st.LastEvent.IsZero() || time.Since(st.LastEvent) < idle {
			return "working", fmt.Sprintf("that agent is working: it may be put to sleep after %d minutes without activity", g.IdleMin)
		}
	}
	return "", ""
}

// reserveForBoard writes a launch or wake into the log, within the grant's caps when the switch is on (the caps and the write are one statement).
func (h *SessionsHandler) reserveForBoard(ctx context.Context, project, kind, actor, target string, g board.OrchGrant) (int64, error) {
	if !g.Enabled {
		return h.bs.ReserveLifecycle(ctx, project, kind, actor, target, nil)
	}
	live := 0
	if rows, err := h.ss.GetBoardSessions(ctx, project); err == nil {
		for _, s := range rows {
			if s.IsSleeping == 0 && s.IsArchived == 0 {
				live++
			}
		}
	}
	return h.bs.ReserveLifecycle(ctx, project, kind, actor, target, &board.LifecycleCaps{MaxPerHour: g.MaxPerHour, MaxLive: g.MaxLive, Live: live})
}

// refuseCap answers 429 with which cap was reached and how to raise it; any other error is a 500.
func (h *SessionsHandler) refuseCap(w http.ResponseWriter, err error, g board.OrchGrant) {
	switch {
	case errors.Is(err, board.ErrLifecycleCapHour):
		orchRefusal(w, http.StatusTooManyRequests, "board_hourly_limit", fmt.Sprintf("this board's limit of %d launches and wakes an hour is used up: wait, or the Operator can raise it", g.MaxPerHour))
	case errors.Is(err, board.ErrLifecycleCapLive):
		orchRefusal(w, http.StatusTooManyRequests, "board_live_limit", fmt.Sprintf("this board already has %d live agents: put some to sleep, or the Operator can raise the limit", g.MaxLive))
	default:
		errInternalServer(w, "could not write the log")
	}
}

// orchActor is the name the log and the board line carry for the seat: its member name on the board, cleaned.
func (h *SessionsHandler) orchActor(seat *store.LiveSession) string {
	name := seat.AgentName
	if seat.DisplayName != nil && *seat.DisplayName != "" {
		name = *seat.DisplayName
	}
	return orchName(name)
}

// sayLifecycle puts one line on the board, from Coral, so the board shows what was done to its agents.
func (h *SessionsHandler) sayLifecycle(ctx context.Context, project, text string) {
	if _, err := h.bs.PostSystemMessage(ctx, project, "Coral", "[Coral] "+text, nil); err != nil {
		slog.Warn("lifecycle line not posted", "board", project, "error", err)
	}
}

// sleepNow puts a session to sleep: its terminal is killed to free resources and the row says it sleeps (what the session's own sleep route does).
func (h *SessionsHandler) sleepNow(ctx context.Context, sess *store.LiveSession) {
	h.modelSwitches.end(sess.SessionID, "The agent was put to sleep before the change was confirmed.") // #6219
	h.ss.SetSessionSleeping(ctx, sess.SessionID, true)
	if err := h.terminal.KillSessionOnly(ctx, sess.AgentName, sess.AgentType, sess.SessionID); err != nil {
		slog.Warn("failed to kill the terminal while putting an agent to sleep", "session", sess.SessionID[:min(8, len(sess.SessionID))], "error", err)
	}
}

// beginAgentLaunch writes an agent's launch onto a board into the board's log (whether or not the switch is on: today's helper launches become visible) and, when the Operator's switch is on, holds it to the
// board's caps in the same statement. It answers the refusal itself and returns the log row to finish; 0 means nothing was logged (not an agent's launch, or no board to log it on).
func (h *SessionsHandler) beginAgentLaunch(w http.ResponseWriter, r *http.Request, project, target string) (int64, bool) {
	id, g, err := h.reserveAgentLaunch(r, project, target)
	if err != nil {
		h.refuseCap(w, err, g)
		return 0, false
	}
	return id, true
}

// reserveAgentLaunch is the log row and cap check of one agent launch; a team launch calls it once per member, so a team cannot start more than the caps allow. The id is 0 when nothing is logged (not an agent's
// launch, or no board). The error is a cap (refuseCap says it) or a failure to read or write.
func (h *SessionsHandler) reserveAgentLaunch(r *http.Request, project, target string) (int64, board.OrchGrant, error) {
	owner, hasSession := VerifiedSession(r.Context())
	isAgent := hasSession || callerActor(r).Kind == ActorToken
	if !isAgent || h.bs == nil || project == "" {
		return 0, board.OrchGrant{}, nil
	}
	g, err := h.bs.GetOrchGrant(r.Context(), project)
	if err != nil {
		return 0, g, err
	}
	actor := ""
	if hasSession {
		if sess, err := h.ss.GetLiveSession(r.Context(), owner.SessionID); err == nil && sess != nil {
			actor = h.orchActor(sess)
		}
		if actor == "" {
			actor = orchName(owner.SessionName)
		}
	}
	if actor == "" {
		actor = orchName(callerActor(r).Name)
	}
	id, err := h.reserveForBoard(r.Context(), project, board.LifecycleLaunch, actor, orchName(target), g)
	return id, g, err
}

// capRefusal is refuseCap's answer as a team member's entry: the member is not started and says which cap.
func capRefusal(err error, g board.OrchGrant) (code, msg string) {
	switch {
	case errors.Is(err, board.ErrLifecycleCapHour):
		return "board_hourly_limit", fmt.Sprintf("this board's limit of %d launches and wakes an hour is used up: wait, or the Operator can raise it", g.MaxPerHour)
	case errors.Is(err, board.ErrLifecycleCapLive):
		return "board_live_limit", fmt.Sprintf("this board already has %d live agents: put some to sleep, or the Operator can raise the limit", g.MaxLive)
	}
	return "lifecycle_log_failed", "could not write the log"
}

// endAgentLaunch records how an agent's launch went and, when the switch is on, says it on the board.
func (h *SessionsHandler) endAgentLaunch(ctx context.Context, project string, id int64, started bool, actorTarget string) {
	if id == 0 {
		return
	}
	status, note := "ok", ""
	if !started {
		status, note = "failed", "the launch failed"
	}
	_ = h.bs.FinishLifecycle(ctx, id, status, note)
	if started {
		if g, err := h.bs.GetOrchGrant(ctx, project); err == nil && g.Enabled {
			h.sayLifecycle(ctx, project, actorTarget)
		}
	}
}

// launchTargetName is what the log calls a launched agent before it has a name of its own: the display name asked for, else its type.
func launchTargetName(display, agentType string) string {
	if strings.TrimSpace(display) != "" {
		return display
	}
	return agentType
}

// orchActorOf is the launching agent's name for the board line.
func (h *SessionsHandler) orchActorOf(r *http.Request) string {
	if owner, ok := VerifiedSession(r.Context()); ok {
		if sess, err := h.ss.GetLiveSession(r.Context(), owner.SessionID); err == nil && sess != nil {
			return h.orchActor(sess)
		}
		return orchName(owner.SessionName)
	}
	return ""
}

func launcherWords(name string) string {
	if name == "" {
		return "An agent"
	}
	return name
}
