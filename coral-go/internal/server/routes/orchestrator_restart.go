package routes

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// POST /api/board/{project}/agents/{subscriber}/restart[?when_idle=1] (#15112): the board's Orchestrator restarts an agent of its board as a fresh session with the settings it was launched with (its CLI, model, mode, folder,
// board seat and job title: the dashboard's own Restart with nothing changed), under the Operator's wake grant. The same narrow rules as wake and sleep: the seat the Operator named, on EVERY request, the switch on, the
// board not paused, a member of this board that is a plain agent, never the seat itself, the hour's cap shared with wake and launch, no body read, never through the Hub or a sign-in link.

// restartWhenIdleFor is how long a restart that waits for the agent's next idle waits before it is dropped.
const restartWhenIdleFor = 2 * time.Hour

// restartIdleEvery is how often a waiting restart looks at its agent again.
var restartIdleEvery = 5 * time.Second

// orchRestartCapture takes the answer the dashboard's restart steps write, so a failed step is a refusal here and not a body for a request that is not theirs.
type orchRestartCapture struct {
	header http.Header
	code   int
	body   []byte
}

func (c *orchRestartCapture) Header() http.Header {
	if c.header == nil {
		c.header = http.Header{}
	}
	return c.header
}
func (c *orchRestartCapture) WriteHeader(code int) { c.code = code }
func (c *orchRestartCapture) Write(b []byte) (int, error) {
	if c.code == 0 {
		c.code = http.StatusOK
	}
	c.body = append(c.body, b...)
	return len(b), nil
}

// OrchestratorRestart: POST /api/board/{project}/agents/{subscriber}/restart. No body is read; ?when_idle=1 queues it for the agent's next idle.
func (h *SessionsHandler) OrchestratorRestart(w http.ResponseWriter, r *http.Request) {
	project := chi.URLParam(r, "project")
	g, seat, ok := h.orchSeat(w, r, project)
	if !ok {
		return
	}
	target, member, ok := h.orchTarget(w, r, project, seat)
	if !ok {
		return
	}
	actor, who := h.orchActor(seat), orchName(member)
	if code, why := h.restartBusyReason(r.Context(), target); code != "" {
		if r.URL.Query().Get("when_idle") == "" {
			orchRefusal(w, http.StatusConflict, code, why+" (ask again when it is idle, or restart with when_idle to queue it)")
			return
		}
		if !h.queueRestart(project, target.SessionID, member, who, actor, g) {
			orchRefusal(w, http.StatusConflict, "already_queued", "a restart of that agent is already waiting for its next idle")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "queued": who, "note": why})
		return
	}
	status, code, msg := h.restartAsSeat(r.Context(), project, target, member, who, actor, g)
	if status != http.StatusOK {
		orchRefusal(w, status, code, msg)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "restarted": who})
}

// restartBusyReason says why an agent is not restarted now: it is in the middle of a turn, or waits on the person (a restart would lose the question).
func (h *SessionsHandler) restartBusyReason(ctx context.Context, target *store.LiveSession) (code, why string) {
	if target.IsSleeping == 1 {
		return "", ""
	}
	st := h.deriveSingleSessionState(ctx, target.SessionID, 0)
	switch {
	case st.NeedsInput:
		return "waiting_for_the_person", "that agent waits for the person's answer"
	case st.InTurn || st.Working:
		return "working", "that agent is in the middle of a turn"
	}
	return "", ""
}

// restartAsSeat reserves the restart in the log (within the caps), restarts the session as the dashboard's Restart does with nothing changed, and says it on the board. status is 200 when it was done.
func (h *SessionsHandler) restartAsSeat(ctx context.Context, project string, target *store.LiveSession, member, who, actor string, g board.OrchGrant) (status int, code, msg string) {
	id, err := h.reserveForBoard(ctx, project, board.LifecycleRestart, actor, who, g)
	if err != nil {
		code, m := capRefusal(err, g)
		if code == "lifecycle_log_failed" {
			return http.StatusInternalServerError, code, m
		}
		return http.StatusTooManyRequests, code, m
	}
	name := naming.SessionName(target.AgentType, target.SessionID)
	end, free := h.beginRestart(name)
	if !free {
		_ = h.bs.FinishLifecycle(ctx, id, "failed", "already being restarted")
		return http.StatusConflict, "restart_busy", "that agent is already being restarted; wait for it to finish"
	}
	defer end()
	defer h.kickWS()
	lctx, cancel := lifecycleCtx(ctx)
	defer cancel()
	fail := func(note string) (int, string, string) {
		_ = h.bs.FinishLifecycle(ctx, id, "failed", note)
		return http.StatusBadGateway, "restart_failed", "Coral could not restart that agent"
	}
	plan, failed := h.restartResolve(lctx, name, restartRequest{SessionID: target.SessionID, AgentType: target.AgentType})
	if failed != nil {
		var c orchRestartCapture
		failed(&c)
		slog.Warn("orchestrator restart: not resolved", "board", project, "status", c.code)
		return fail("the restart could not be worked out")
	}
	plan.keepSource = store.KeepSourceLocal
	plan.restartSettings()
	if plan.stored != nil {
		h.modelSwitches.end(plan.stored.SessionID, "The agent was restarted before the change was confirmed.")
		h.stopOpencode(plan.stored.SessionID)
	}
	cmd, failed := h.restartCommand(lctx, plan)
	if failed != nil {
		var c orchRestartCapture
		failed(&c)
		slog.Warn("orchestrator restart: no start command", "board", project, "status", c.code)
		return fail("the start command could not be built")
	}
	tgt, failed := h.restartTerminal(lctx, plan)
	if failed != nil {
		var c orchRestartCapture
		failed(&c)
		slog.Warn("orchestrator restart: terminal", "board", project, "status", c.code)
		return fail("the terminal could not be restarted")
	}
	if failed := h.restartLaunch(lctx, plan, tgt, cmd); failed != nil {
		var c orchRestartCapture
		failed(&c)
		slog.Warn("orchestrator restart: launch", "board", project, "status", c.code)
		return fail("the agent could not be started")
	}
	h.restartRecord(lctx, plan)
	_ = h.bs.FinishLifecycle(ctx, id, "ok", "")
	h.sayLifecycle(ctx, project, actor+" restarted "+who)
	return http.StatusOK, "", ""
}

// pendingRestarts holds the agents whose restart waits for their next idle: one per session.
func (h *SessionsHandler) queueRestart(project, sessionID, member, who, actor string, g board.OrchGrant) bool {
	if _, dup := h.restartQueued.LoadOrStore(sessionID, struct{}{}); dup {
		return false
	}
	go func() {
		defer h.restartQueued.Delete(sessionID)
		ctx, cancel := context.WithTimeout(context.Background(), restartWhenIdleFor)
		defer cancel()
		t := time.NewTicker(restartIdleEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				slog.Info("orchestrator restart: dropped, the agent was not idle in time", "board", project)
				return
			case <-t.C:
			}
			cur, err := h.ss.GetLiveSession(ctx, sessionID)
			if err != nil || cur == nil || cur.IsArchived == 1 || ptr.Value(cur.BoardName) != project {
				return // gone, archived or moved to another board: nothing to restart
			}
			if h.boardHandler != nil && h.boardHandler.IsPaused(project) {
				continue
			}
			if gr, err := h.bs.GetOrchGrant(ctx, project); err != nil || !gr.Enabled || gr.SeatSession != g.SeatSession {
				return // the Operator withdrew or changed the grant while it waited
			} else {
				g = gr
			}
			if code, _ := h.restartBusyReason(ctx, cur); code != "" {
				continue
			}
			if st, code, msg := h.restartAsSeat(ctx, project, cur, member, who, actor, g); st != http.StatusOK {
				slog.Warn("orchestrator restart: the queued restart was refused", "board", project, "code", code, "message", msg)
			}
			return
		}
	}()
	return true
}
