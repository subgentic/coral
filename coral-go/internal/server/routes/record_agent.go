package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// "Record as agent" (#391). An agent that was already running when Coral updated has no record of its agent process, so its board notices are paused until it is restarted, woken or
// recorded. These Operator-only routes (operatorOnlyRoutes: an agent's token cannot use them) let the Operator say that the one program in the foreground of the agent's terminal IS
// the agent: one agent (the dashboard shows the pid and the program first, and the request carries what was shown, so a program that changed in between is refused), or, after an
// update, every paused agent whose foreground program is its resolved CLI. Anything ambiguous is left paused and listed. Each record is logged.

// agentTarget is the live session and its terminal name, or writes the answer and returns false.
func (h *SessionsHandler) agentTarget(w http.ResponseWriter, r *http.Request) (*store.LiveSession, string, bool) {
	ls, err := h.ss.GetLiveSession(r.Context(), chi.URLParam(r, "sessionID"))
	if err != nil || ls == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "code": "not_found", "error": "Session not found"})
		return nil, "", false
	}
	return ls, naming.SessionName(ls.AgentType, ls.SessionID), true
}

// noticesPaused is whether board notices are withheld from the terminal now, and why. A terminal that cannot say is not "paused" here: a record cannot fix it.
func (h *SessionsHandler) noticesPaused(ctx context.Context, ls *store.LiveSession, name string) (paused bool, reason string) {
	if h.terminal == nil || ls.AgentType == at.Terminal {
		return false, ""
	}
	ok, wait, why, known := ptymanager.NoticeState(ctx, h.terminal, name, ls.AgentType, ls.SessionID)
	if !known || ok || wait {
		return false, ""
	}
	return true, why
}

// AgentCandidate: GET /api/sessions/live/{sessionID}/agent-candidate (Operator only). Are this agent's notices paused, and which single program could be recorded as the agent.
func (h *SessionsHandler) AgentCandidate(w http.ResponseWriter, r *http.Request) {
	ls, name, ok := h.agentTarget(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	paused, reason := h.noticesPaused(ctx, ls, name)
	out := map[string]any{"ok": true, "paused": paused, "reason": reason, "candidate": nil, "why_not": ""}
	if paused {
		if rec, can := h.terminal.(ptymanager.AgentRecorder); can {
			cand, why, err := rec.AgentCandidate(ctx, name, ls.AgentType, ls.SessionID)
			switch {
			case err != nil:
				out["why_not"] = "the terminal could not be read"
			case why != "":
				out["why_not"] = why
			default:
				out["candidate"] = cand
			}
		} else {
			out["why_not"] = "this terminal cannot record an agent"
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// RecordAgent: POST /api/sessions/live/{sessionID}/record-agent {"pid":123,"start":"..."} (Operator only). Records the program that was shown as this agent's, if it is still the one
// foreground program.
func (h *SessionsHandler) RecordAgent(w http.ResponseWriter, r *http.Request) {
	ls, name, ok := h.agentTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		PID   int    `json:"pid"`
		Start string `json:"start"`
		// AcknowledgeNested: the Operator ticked "I know this is the agent, not something I started by hand" for a program running inside a nested shell.
		AcknowledgeNested bool `json:"acknowledge_nested"`
	}
	if err := decodeJSON(r, &body); err != nil || body.PID <= 0 || body.Start == "" {
		errBadRequest(w, "pid and start (as the agent-candidate answer gave them) are required")
		return
	}
	rec, can := h.terminal.(ptymanager.AgentRecorder)
	if !can || ls.AgentType == at.Terminal {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "code": "not_supported", "error": "this terminal cannot record an agent"})
		return
	}
	// A program running inside a nested shell is what the notice check exists to stop: it is recorded only on the Operator's explicit acknowledgement (Security on #391).
	under := ""
	if cur, _, cerr := rec.AgentCandidate(r.Context(), name, ls.AgentType, ls.SessionID); cerr == nil && cur.PID == body.PID {
		under = cur.Under
	}
	if under != "" && !body.AcknowledgeNested {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "code": "acknowledge_nested", "under": under,
			"error": "this program is running inside " + under + ", a shell started in the terminal, not directly in the agent's terminal: acknowledge it to record it"})
		return
	}
	got, err := rec.RecordAgent(r.Context(), name, ls.AgentType, ls.SessionID, ptymanager.AgentCandidate{PID: body.PID, Start: body.Start})
	switch {
	case err == nil:
		slog.Info("the Operator recorded an agent's process", "session", name, "pid", got.PID, "program", got.Program, "under_nested_shell", under, "acknowledged", body.AcknowledgeNested)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pid": got.PID, "program": got.Program})
	case errors.Is(err, ptymanager.ErrCandidateChanged), errors.Is(err, ptymanager.ErrNoCandidate):
		slog.Warn("the Operator's record of an agent's process was refused: the foreground changed", "session", name, "pid", body.PID, "error", err)
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "code": "changed", "error": "the foreground program is no longer that process"})
	case errors.Is(err, ptymanager.ErrTerminalGone):
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "code": "terminal_gone", "error": "this agent's terminal is gone"})
	default:
		slog.Error("recording an agent's process failed", "session", name, "error", err)
		errInternalServer(w, "recording the agent's process failed")
	}
}

type recordedAgent struct {
	Session string `json:"session"`
	PID     int    `json:"pid"`
	Program string `json:"program"`
}

type leftAgent struct {
	Session string `json:"session"`
	Reason  string `json:"reason"`
}

// RecordAgents: POST /api/sessions/record-agents (Operator only), after an update. Every agent whose notices are paused and whose single foreground program is its resolved CLI is
// recorded. The match is the program's image path against the resolved CLI path; anything else (a script run by node, a wrapper, two programs, an unreadable image) is left paused
// and listed.
func (h *SessionsHandler) RecordAgents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rec, can := h.terminal.(ptymanager.AgentRecorder)
	if !can {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "code": "not_supported", "error": "this terminal cannot record an agent"})
		return
	}
	settings, serr := h.launchSettings(ctx)
	if serr != nil {
		errInternalServer(w, serr.Error())
		return
	}
	all, err := h.ss.GetAllLiveSessions(ctx)
	if err != nil {
		errInternalServer(w, "reading the agents failed")
		return
	}
	recorded, left := []recordedAgent{}, []leftAgent{}
	for i := range all {
		ls := &all[i]
		name := naming.SessionName(ls.AgentType, ls.SessionID)
		if paused, _ := h.noticesPaused(ctx, ls, name); !paused || ls.IsSleeping == 1 {
			continue // notices already go (or the agent sleeps): nothing to record
		}
		cand, why, cerr := rec.AgentCandidate(ctx, name, ls.AgentType, ls.SessionID)
		switch {
		case cerr != nil:
			left = append(left, leftAgent{name, "the terminal could not be read"})
			continue
		case why != "":
			left = append(left, leftAgent{name, why})
			continue
		}
		if cand.Under != "" {
			// A hand-started copy of the real CLI is still not this session's agent: a program under a nested shell is never recorded in bulk.
			left = append(left, leftAgent{name, "needs the button: the program runs inside " + cand.Under + ", a shell started in the terminal"})
			continue
		}
		cli, lerr := agent.LaunchCLI(settings, ls.AgentType)
		if lerr != nil || cli == "" {
			left = append(left, leftAgent{name, "the agent's CLI could not be resolved"})
			continue
		}
		if !sameImage(cand.Image, cli) {
			left = append(left, leftAgent{name, "ambiguous: the program is " + programName(cand) + ", not the resolved CLI (a script run by an interpreter, or a wrapper): record it with the button"})
			continue
		}
		got, rerr := rec.RecordAgent(ctx, name, ls.AgentType, ls.SessionID, cand)
		if rerr != nil {
			left = append(left, leftAgent{name, "the foreground changed while recording"})
			continue
		}
		recorded = append(recorded, recordedAgent{name, got.PID, got.Program})
	}
	slog.Info("the Operator recorded the agents' processes after an update", "recorded", len(recorded), "left", len(left))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "recorded": recorded, "left": left})
}

func programName(c ptymanager.AgentCandidate) string {
	if c.Program != "" {
		return filepath.Base(strings.ReplaceAll(c.Program, "\\", "/"))
	}
	return "unknown"
}

// sameImage is whether the program's image path is the resolved CLI's, symlinks resolved on both sides (Windows paths compare without case). An unreadable image is never the same.
func sameImage(image, cli string) bool {
	if image == "" || cli == "" {
		return false
	}
	a, b := resolvedPath(image), resolvedPath(cli)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func resolvedPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Clean(p)
}
