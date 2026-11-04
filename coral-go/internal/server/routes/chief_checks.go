package routes

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

type ChiefChecksHandler struct {
	sched     *store.ScheduleStore
	sessions  *SessionsHandler
	scheduler *background.JobScheduler
	mu        sync.Mutex // serialize state changes with delivery (never post a reminder after resolution)
	now       func() time.Time
}

func NewChiefChecksHandler(db *store.DB, sessions *SessionsHandler) *ChiefChecksHandler {
	return &ChiefChecksHandler{sched: store.NewScheduleStore(db), sessions: sessions, now: time.Now}
}
func (h *ChiefChecksHandler) SetScheduler(s *background.JobScheduler) {
	h.scheduler = s
	s.SetCheckDeliveryFn(h.DeliverScheduledCheck)
	s.SetCheckPollFn(h.Poll)
}
func (h *ChiefChecksHandler) Register(r chi.Router) {
	r.Get("/api/chief/checks", h.list)
	r.Post("/api/chief/checks", h.save)
	r.Get("/api/chief/checks/{checkID}", h.get)
	r.Put("/api/chief/checks/{checkID}", h.save)
	r.Delete("/api/chief/checks/{checkID}", h.remove)
	r.Post("/api/chief/checks/{checkID}/run", h.run)
	r.Get("/api/chief/triggers", h.triggers)
	r.Post("/api/chief/triggers/{triggerID}/state", h.state)
}

// chiefLocal and chiefPerson are defence in depth: the router identity table and
// tunnel policy also reject these callers before dispatch in the full server.
func chiefLocal(w http.ResponseWriter, r *http.Request) bool {
	if cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		commentRefuse(w, 404, "not_available_through_hub", "Chief checks are not available through the Hub")
		return false
	}
	return true
}
func chiefPerson(w http.ResponseWriter, r *http.Request) bool {
	if !chiefLocal(w, r) {
		return false
	}
	if !humanInputCaller(r) {
		commentRefuse(w, 403, "owner_only", "only the person at this computer can manage checks")
		return false
	}
	return true
}
func chiefID(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	n, err := strconv.ParseInt(chi.URLParam(r, key), 10, 64)
	if err != nil || n < 1 {
		errBadRequest(w, "invalid id")
		return 0, false
	}
	return n, true
}
func chiefError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrChiefNotFound):
		errNotFound(w, "check or trigger not found")
	case errors.Is(err, store.ErrChiefConflict):
		commentRefuse(w, 409, "revision_conflict", "the check changed; reload it before saving")
	case errors.Is(err, store.ErrChiefCapacity):
		commentRefuse(w, 409, "capacity", "check history is full; resolve old triggers first")
	default:
		errInternalServer(w, "the check operation failed")
	}
}
func chiefStateError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrChiefTriggerConflict) {
		commentRefuse(w, 409, "trigger_conflict", "another trigger is already open for that check")
		return
	}
	chiefError(w, err)
}

func (h *ChiefChecksHandler) list(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	rows, err := h.sched.ChiefChecks(r.Context())
	if err != nil {
		chiefError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"checks": rows})
}
func (h *ChiefChecksHandler) get(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	id, ok := chiefID(w, r, "checkID")
	if !ok {
		return
	}
	c, err := h.sched.ChiefCheck(r.Context(), id)
	if err != nil || c.Deleted {
		errNotFound(w, "check not found")
		return
	}
	writeJSON(w, 200, c)
}

// target is the exact active board membership, never a job-title/name fallback.
func (h *ChiefChecksHandler) target(ctx context.Context, b, sid string) (*store.LiveSession, *board.Subscriber, error) {
	if h.sessions == nil || h.sessions.ss == nil || h.sessions.bs == nil {
		return nil, nil, errors.New("unavailable")
	}
	ls, err := h.sessions.ss.GetLiveSession(ctx, sid)
	if err != nil || ls == nil || ls.IsArchived != 0 || ls.AgentType == "terminal" {
		return nil, nil, errors.New("target_gone")
	}
	subs, err := h.sessions.bs.ListSubscribers(ctx, b)
	if err != nil {
		return nil, nil, errors.New("target_gone")
	}
	for _, sub := range subs {
		if sub.IsActive != 0 && naming.SessionIDFromName(sub.SessionName) == sid && strings.TrimSpace(sub.JobTitle) != "" {
			s := sub
			return ls, &s, nil
		}
	}
	return nil, nil, errors.New("target_not_on_board")
}
func (h *ChiefChecksHandler) save(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 14<<10)
	var c store.ChiefCheck
	if err := decodeJSONStrict(r, &c); err != nil {
		errBadRequest(w, "send check fields as JSON; credentials and connector settings are not accepted")
		return
	}
	c.ID, c.JobID = 0, 0
	if r.Method == http.MethodPut {
		id, ok := chiefID(w, r, "checkID")
		if !ok {
			return
		}
		c.ID = id
	}
	text := c.Name + "\n" + c.Instruction + "\n" + c.SourceKey
	if hasSignInLink(text) {
		writeError(w, 400, "sign_in_link", signInLinkRefusal)
		return
	}
	safe, ok := redactChiefText(text)
	if !ok {
		commentRefuse(w, 503, "secret_check_unavailable", "the instruction could not be checked; nothing was saved")
		return
	}
	if safe != text {
		commentRefuse(w, 400, "secret_not_saved", "remove the secret from the instruction or name; the check was not saved")
		return
	}
	c.Name = strings.TrimSpace(clitext.Clean(c.Name))
	c.Instruction = strings.TrimSpace(clitext.Clean(c.Instruction))
	c.SourceKey = clitext.Clean(c.SourceKey)
	if _, err := store.ChiefCron(c); err != nil {
		errBadRequest(w, err.Error())
		return
	}
	if _, _, err := h.target(r.Context(), c.TargetBoard, c.TargetSession); err != nil {
		commentRefuse(w, 400, "invalid_target", "choose a live member of the target board; the check was not saved")
		return
	}
	saved, err := h.sched.SaveChiefCheck(r.Context(), c)
	if err != nil {
		chiefError(w, err)
		return
	}
	status := 200
	if c.ID == 0 {
		status = 201
	}
	writeJSON(w, status, saved)
}
func (h *ChiefChecksHandler) remove(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	id, ok := chiefID(w, r, "checkID")
	if !ok {
		return
	}
	var b struct {
		Revision int64 `json:"revision"`
	}
	if !readJSONBody(w, r, 1024, &b) {
		return
	}
	if err := h.sched.DeleteChiefCheck(r.Context(), id, b.Revision); err != nil {
		chiefError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (h *ChiefChecksHandler) run(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	id, ok := chiefID(w, r, "checkID")
	if !ok {
		return
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(key) < 8 || len(key) > 128 || clitext.Clean(key) != key {
		errBadRequest(w, "an Idempotency-Key of 8 to 128 plain characters is required")
		return
	}
	if h.scheduler == nil {
		commentRefuse(w, 503, "scheduler_unavailable", "scheduler is not ready")
		return
	}
	c, err := h.sched.ChiefCheck(r.Context(), id)
	if err != nil || c.Deleted {
		errNotFound(w, "check not found")
		return
	}
	t, err := h.sched.BeginChiefTrigger(r.Context(), id, 0, "manual:"+key, h.now())
	if err != nil {
		chiefError(w, err)
		return
	}
	if t.RunID == 0 && t.State != "done" {
		if _, err = h.scheduler.RunNow(r.Context(), c.JobID); err != nil && !errors.Is(err, background.ErrJobRunning) {
			h.sched.FinishChiefDelivery(r.Context(), t.ID, "delivery", "failed", "scheduler_unavailable", 0, h.now())
			commentRefuse(w, 409, "scheduler_busy", "the check could not be scheduled; its trigger records the failure")
			return
		}
	}
	writeJSON(w, 202, map[string]any{"trigger": t})
}
func (h *ChiefChecksHandler) triggers(w http.ResponseWriter, r *http.Request) {
	if !chiefPerson(w, r) {
		return
	}
	q := r.URL.Query()
	var id, before int64
	var err error
	if q.Get("check_id") != "" {
		id, err = strconv.ParseInt(q.Get("check_id"), 10, 64)
		if err != nil || id < 1 {
			errBadRequest(w, "invalid check_id")
			return
		}
	}
	if q.Get("before") != "" {
		before, err = strconv.ParseInt(q.Get("before"), 10, 64)
		if err != nil || before < 1 {
			errBadRequest(w, "invalid before")
			return
		}
	}
	state := q.Get("state")
	if state != "" && state != "open" && state != "done" && state != "routed" && state != "waiting_on_operator" {
		errBadRequest(w, "invalid state")
		return
	}
	rows, err := h.sched.ChiefTriggers(r.Context(), id, before, state)
	if err != nil {
		chiefError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"triggers": rows, "summary_notice": "Agent summaries are the agent's words, kept on this computer."})
}
func (h *ChiefChecksHandler) state(w http.ResponseWriter, r *http.Request) {
	if !chiefLocal(w, r) {
		return
	}
	owner, agent := VerifiedSession(r.Context())
	if !agent && !humanInputCaller(r) {
		commentRefuse(w, 403, "forbidden", "only the receiving agent or the person may update this trigger")
		return
	}
	id, ok := chiefID(w, r, "triggerID")
	if !ok {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	t, err := h.sched.ChiefTrigger(r.Context(), id)
	if err != nil {
		chiefError(w, err)
		return
	}
	if agent && (owner == nil || owner.SessionID != t.TargetSession) {
		commentRefuse(w, 403, "wrong_session", "this trigger belongs to another session")
		return
	}
	_, sub, err := h.target(r.Context(), t.TargetBoard, t.TargetSession)
	if agent && err != nil {
		commentRefuse(w, 403, "target_gone", "the receiving session is no longer a member of this board")
		return
	}
	var b struct {
		State   string `json:"state"`
		Summary string `json:"summary"`
		TaskID  int64  `json:"task_id"`
		AskID   int64  `json:"ask_id"`
		BriefID int64  `json:"brief_id"`
	}
	if !readJSONBody(w, r, 4<<10, &b) {
		return
	}
	if len(b.Summary) > 2048 {
		errBadRequest(w, "a summary is at most 2 KiB")
		return
	}
	if b.State != "open" && b.State != "done" && b.State != "routed" && b.State != "waiting_on_operator" {
		errBadRequest(w, "invalid trigger state")
		return
	}
	if !agent {
		if b.State != "open" && b.State != "done" {
			errBadRequest(w, "the person may only resolve or reopen a trigger")
			return
		}
		// One state-only UPDATE preserves the latest agent report and all links;
		// never copy fields from the earlier list read or the UI request body.
		if err = h.sched.SetChiefTriggerResolution(r.Context(), id, b.State, h.now()); err != nil {
			chiefStateError(w, err)
			return
		}
		out, err := h.sched.ChiefTrigger(r.Context(), id)
		if err != nil {
			chiefError(w, err)
			return
		}
		writeJSON(w, 200, out)
		return
	}
	if b.State == "routed" {
		task, e := h.sessions.bs.GetTask(r.Context(), t.TargetBoard, b.TaskID)
		if e != nil || task == nil {
			errBadRequest(w, "routed requires a task on this board")
			return
		}
	} else if b.TaskID != 0 {
		errBadRequest(w, "task_id goes with routed")
		return
	}
	if b.State == "waiting_on_operator" {
		asker, e := h.sessions.bs.AskAsker(r.Context(), t.TargetBoard, b.AskID)
		author, authorErr := h.sessions.bs.MessageSession(r.Context(), t.TargetBoard, b.AskID)
		if e != nil || authorErr != nil || author != t.TargetSession || sub == nil || asker != sub.SubscriberID {
			errBadRequest(w, "waiting requires an ask created by the receiving session on this board")
			return
		}
	} else if b.AskID != 0 {
		errBadRequest(w, "ask_id goes with waiting_on_operator")
		return
	}
	if agent && t.NotifyMode == "daily_brief" && b.State == "done" && b.BriefID == 0 {
		errBadRequest(w, "daily brief results remain open until the actual brief message is linked")
		return
	}
	if b.BriefID != 0 {
		msg, e := h.sessions.bs.GetMessageByID(r.Context(), t.TargetBoard, b.BriefID)
		author, authorErr := h.sessions.bs.MessageSession(r.Context(), t.TargetBoard, b.BriefID)
		if e != nil || authorErr != nil || author != t.TargetSession || msg == nil || sub == nil || msg.SubscriberID != sub.SubscriberID {
			errBadRequest(w, "brief_id must name this agent's own message on this board")
			return
		}
	}
	summary, ok := redactChiefText(clitext.Clean(b.Summary))
	if !ok {
		commentRefuse(w, 503, "secret_check_unavailable", "the summary could not be checked; nothing was saved")
		return
	}
	if err = h.sched.UpdateChiefTriggerState(r.Context(), id, b.State, summary, b.TaskID, b.AskID, b.BriefID, h.now()); err != nil {
		chiefStateError(w, err)
		return
	}
	out, err := h.sched.ChiefTrigger(r.Context(), id)
	if err != nil {
		chiefError(w, err)
		return
	}
	writeJSON(w, 200, out)
}

func (h *ChiefChecksHandler) DeliverScheduledCheck(ctx context.Context, job store.ScheduledJob, runID int64) error {
	c, err := h.sched.ChiefCheckForJob(ctx, job.ID)
	if err != nil || c.Deleted {
		return errors.New("check_deleted")
	}
	t, err := h.sched.BeginChiefTrigger(ctx, c.ID, runID, "slot:"+strconv.FormatInt(runID, 10), h.now())
	if err != nil {
		return errors.New("trigger_unavailable")
	}
	if t.State == "done" {
		return nil
	}
	if err = h.deliverTrigger(ctx, t.ID, "delivery"); err != nil {
		return err
	}
	latest, err := h.sched.ChiefTrigger(ctx, t.ID)
	if err != nil || latest.Delivery != "delivered" {
		return errors.New("delivery_pending_or_failed")
	}
	return nil
}
func (h *ChiefChecksHandler) Poll(ctx context.Context) {
	if h.sessions == nil || h.sessions.bs == nil {
		return
	}
	if err := h.sched.PruneChiefHistory(ctx, h.now()); err != nil {
		return
	}
	rows, err := h.sched.ChiefPendingDelivery(ctx, h.now())
	if err == nil {
		for _, t := range rows {
			kind := "delivery"
			if t.Delivery == "delivered" {
				kind = "reminder"
			}
			h.deliverTrigger(ctx, t.ID, kind)
		}
	}
	keys, err := h.sessions.bs.OldChiefDeliveryKeys(ctx, h.now().Add(-30*24*time.Hour).Unix())
	if err == nil {
		for _, key := range keys {
			if tr, err := h.sched.ChiefTrigger(ctx, key.TriggerID); errors.Is(err, store.ErrChiefNotFound) || (err == nil && tr.DeliveryKey != key.Key) {
				h.sessions.bs.ForgetChiefDeliveryKey(ctx, key.Key)
			}
		}
	}
}
func (h *ChiefChecksHandler) deliverTrigger(ctx context.Context, id int64, kind string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	claimed, err := h.sched.ClaimChiefDelivery(ctx, id, kind, now)
	if err != nil {
		return errors.New("delivery_unavailable")
	}
	if !claimed {
		return nil
	}
	finish := func(state, code string, msg int64) error {
		if err := h.sched.FinishChiefDelivery(ctx, id, kind, state, code, msg, h.now()); err != nil {
			return errors.New("delivery_record_failed")
		}
		if state == "failed" || state == "held" {
			return errors.New(code)
		}
		return nil
	}
	t, err := h.sched.ChiefTrigger(ctx, id)
	if err != nil {
		return finish("failed", "trigger_gone", 0)
	}
	ls, sub, err := h.target(ctx, t.TargetBoard, t.TargetSession)
	if err != nil {
		return finish("failed", "target_gone", 0)
	}
	if h.sessions.boardHandler != nil && h.sessions.boardHandler.IsPaused(t.TargetBoard) {
		return finish("held", "board_paused", 0)
	}
	if sub.ReceiveMode == "none" {
		return finish("held", "target_receives_no_messages", 0)
	}
	if ls.IsSleeping != 0 {
		current, e := h.sched.ChiefCheck(ctx, t.CheckID)
		if !t.WakeIfAsleep || e != nil || !current.WakeIfAsleep {
			return finish("held", "wake_consent_required", 0)
		}
		if err = h.wake(ctx, ls, t.TargetBoard); err != nil {
			return finish("failed", "wake_failed_or_capped", 0)
		}
		ls, sub, err = h.target(ctx, t.TargetBoard, t.TargetSession)
		if err != nil || ls.IsSleeping != 0 {
			return finish("failed", "wake_failed", 0)
		}
	}
	switch t.NotifyMode {
	case "only_if_found", "every_time", "daily_brief":
	default:
		return finish("failed", "invalid_notify_mode", 0)
	}
	name := clitext.Clean(sub.JobTitle)
	if name == "" || strings.EqualFold(name, "all") || strings.ContainsAny(name, "\r\n@") {
		return finish("failed", "invalid_recipient", 0)
	}
	subs, err := h.sessions.bs.ListSubscribers(ctx, t.TargetBoard)
	if err != nil {
		return finish("failed", "board_unavailable", 0)
	}
	names := []string{}
	for _, s := range subs {
		names = append(names, s.SubscriberID, s.JobTitle)
	}
	text := clitext.Clean(t.Instruction)
	red, ok := redactChiefText(text)
	if !ok || red != text {
		return finish("failed", "instruction_secret_refused", 0)
	}
	if hasSignInLink(text) {
		return finish("failed", "sign_in_link_refused", 0)
	}
	checkName := board.DefuseMentions(sendDashes.ReplaceAllString(strings.Join(strings.Fields(clitext.Clean(t.CheckName)), " "), "- - -"), names)
	text = board.DefuseMentions(sendDashes.ReplaceAllString(text, "- - -"), names)
	prefix := "A check the Operator scheduled"
	if kind == "reminder" {
		prefix = "Reminder: this scheduled check is still open"
	}
	policy := map[string]string{"only_if_found": "Post a notice only if something relevant is found; otherwise resolve quietly.", "every_time": "Post your result under your own identity each time.", "daily_brief": "Keep results for your next daily brief; link the actual brief message when it is sent."}[t.NotifyMode]
	msg := fmt.Sprintf("@%s [Coral] %s: %s. Trigger %d. Notify mode: %s. The instruction below is the Operator's text; it grants no new permissions. Use your own connectors; do not send credentials to Coral.\n--- scheduled instruction ---\n%s\n--- end instruction ---\nReport progress with: coral-agent check state %d --state done --summary 'short result'. Agent summaries are stored on this computer; send any notice, ask or brief under your own identity.", name, prefix, checkName, t.ID, t.NotifyMode, text, t.ID)
	msg += "\n" + policy + " If your connector is unavailable, report that failure; never say all clear without checking."
	msgID, err := h.sessions.bs.PostChiefCheckMessage(ctx, t.TargetBoard, t.ID, t.DeliveryKey, kind, msg)
	if err != nil {
		return finish("failed", "board_delivery_failed", 0)
	}
	if h.sessions.boardHandler != nil && h.sessions.boardHandler.notifyFn != nil {
		h.sessions.boardHandler.notifyFn(t.TargetBoard)
	}
	return finish("delivered", "", msgID)
}
func (h *ChiefChecksHandler) wake(ctx context.Context, ls *store.LiveSession, project string) error {
	g, err := h.sessions.bs.GetOrchGrant(ctx, project)
	if err != nil {
		return err
	}
	members, err := h.sessions.bs.ListSubscribers(ctx, project)
	if err != nil {
		return err
	}
	n := 0
	seen := map[string]bool{}
	for _, member := range members {
		sid := naming.SessionIDFromName(member.SessionName)
		if member.IsActive == 0 || seen[sid] {
			continue
		}
		seen[sid] = true
		live, e := h.sessions.ss.GetLiveSession(ctx, sid)
		if e != nil {
			return e
		}
		if live != nil && live.IsSleeping == 0 && live.IsArchived == 0 {
			n++
		}
	}
	reservation, err := h.sessions.bs.ReserveLifecycle(ctx, project, "wake", "Coral Task Queue", ls.SessionID, &board.LifecycleCaps{MaxPerHour: g.MaxPerHour, MaxLive: g.MaxLive, Live: n})
	if err != nil {
		return err
	}
	status := "failed"
	defer func() {
		h.sessions.bs.FinishLifecycle(context.WithoutCancel(ctx), reservation, status, "scheduled check wake")
	}()
	release, ok := paceWake(ctx)
	if !ok {
		return errors.New("wake_held")
	}
	defer release()
	if err = h.sessions.wakeSession(ctx, ls, true); err != nil {
		return errors.New("wake_failed")
	}
	status = "ok"
	return nil
}

func redactChiefText(s string) (string, bool) {
	b, err := secrets.CredentialRedactor().Text([]byte(s))
	return string(b), err == nil
}
