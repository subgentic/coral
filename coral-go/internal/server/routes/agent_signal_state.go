package routes

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/sessionstate"
)

// The agent's state from its own signals: what a person's chat message is held for (human_send_hold.go, #6610). Automated input no longer reads it (#7727).

// gateState gives the agent's state from its own signals (#3481, #3475
// phase 1): its hook events, plus the transcript's end of a turn where a CLI fires no
// hook (a denial, an interrupt). ok is false when the session has sent no signal at all
// (no hooks, or none yet): the gate then keeps its screen rule.
//   - Gone: the session ended (SessionEnd).
//   - Blocked: a request the agent itself made is open (PermissionRequest, Elicitation,
//     its permission notification), with what it waits on. Coral's own held notice is
//     not the agent's request and never blocks. For Claude, a question or plan menu is
//     open from its PreToolUse on (menuKinds, #3655), before any notification.
//   - InTurn: a prompt or a tool event is the latest.
//   - Idle: otherwise (a stop, the session's start).
func (h *SessionsHandler) gateState(ctx context.Context, name, agentType, sessionID string) (ptymanager.AgentState, bool) {
	if sessionID == "" {
		_, sessionID = logparse.ParseSessionName(name)
	}
	if sessionID == "" || h.ts == nil {
		return ptymanager.AgentState{}, false
	}
	if agentType == at.Claude && !h.claudeHasRequestSignals(name, sessionID) {
		// An agent launched with an older hook set (or one not heard from since this server
		// started) has no request or turn signals of its own, so they can't say it is idle:
		// the gate keeps its screen rule for it (#3655 F3; QA: fail-safe).
		return ptymanager.AgentState{}, false
	}
	byID, err := h.ts.GetSessionStateEvents(ctx, []string{sessionID})
	events := byID[sessionID]
	if err != nil || len(events) == 0 {
		return ptymanager.AgentState{}, false
	}
	in := SessionStateInput{}
	for _, ev := range events {
		in.Events = append(in.Events, ev.StateEvent())
	}
	workingDir := ""
	if ls, err := h.ss.GetLiveSession(ctx, sessionID); err == nil && ls != nil {
		workingDir = ls.WorkingDir
		if agentType == "" {
			agentType = ls.AgentType
		}
	}
	h.applyTranscriptState(&in, events, agentType, name, sessionID, workingDir)
	st := sessionstate.Derive(in)
	cliVersion := h.runningCLIVersion(ctx, agentType, sessionID, workingDir)
	as := ptymanager.AgentState{
		State:      ptymanager.StateIdle,
		Since:      st.Since,
		LastEvent:  st.LastEvent,
		LastStop:   st.LastStop,
		CLIVersion: cliVersion,
	}
	pt, pending := h.pending.get(sessionID, time.Now())
	as.ToolPending = pending
	menu := ""
	if pending && agentType == at.Claude && !st.LastStop.After(pt.At) {
		// A menu's PreToolUse counts until its PostToolUse, a stop, a prompt or a reset clears
		// it; Esc closes one with no hook at all, so an end of turn (the transcript's, too)
		// after it means it is closed.
		menu = menuKinds[pt.ToolName]
	}
	switch {
	case st.Gone:
		as.State = ptymanager.StateGone
	case st.OwnRequest:
		as.State = ptymanager.StateBlocked
		as.Kind = st.WaitingKind
		if as.Kind == "" {
			as.Kind = "permission"
		}
	case menu != "":
		as.State = ptymanager.StateBlocked
		as.Kind = menu
		as.Since = pt.At
	case st.InTurn:
		as.State = ptymanager.StateInTurn
	}
	return as, true
}

// claudeHasRequestSignals reports whether a Claude session's hooks include the request and turn
// signals (revision agent.ClaudeSignalsHooksRev or later), from the revision its events carry.
// Unknown (no revision since this server started) is not: the screen rule decides until one
// comes. Events without a revision, or an older one, mean an older hook set, logged once per
// session: the agent needs a relaunch or resume.
func (h *SessionsHandler) claudeHasRequestSignals(name, sessionID string) bool {
	v, known := h.hooksRev.Load(sessionID)
	rev, _ := v.(int)
	if rev >= agent.ClaudeSignalsHooksRev {
		return true
	}
	if _, noRev := h.hooksNoRev.Load(sessionID); known || noRev {
		if _, logged := oldHookSets.LoadOrStore(sessionID, true); !logged {
			slog.Info("automated input: this agent's hooks are out of date; the gate keeps the screen rule for it until it is relaunched or resumed",
				"session", name, "hooks_rev", rev, "want", agent.ClaudeSignalsHooksRev)
		}
	}
	return false
}

// oldHookSets are the sessions already logged as having an old hook set.
var oldHookSets sync.Map

// menuKinds are Claude's tools that open a menu for the user, by what it asks (#3655). Their
// PreToolUse fires before the menu is drawn, in every hook set Coral has installed, while the
// PermissionRequest hook is missing from agents launched before v1.4.27 and the permission
// notification comes some 6 s after the menu opens.
var menuKinds = map[string]string{"AskUserQuestion": "question", "ExitPlanMode": "plan"}
