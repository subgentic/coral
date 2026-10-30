package routes

import (
	"context"
	"fmt"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/opencode"
)

// OpencodeRuntime is what an opencode agent needs of the server Coral runs for it (opencode.Manager): the server started for the agent (Ensure), the state its event stream gave (AgentTurn), and the end of
// both with the agent (Stop). The key is the agent's Coral session id.
type OpencodeRuntime interface {
	Ensure(ctx context.Context, key, bin string) (*opencode.Server, error)
	AgentTurn(key string) (opencode.State, time.Time, bool)
	Stop(key string)
}

// SetOpencodeRuntime gives the sessions handler the opencode server manager; nil until the server wires it, and an opencode agent then cannot be launched.
func (h *SessionsHandler) SetOpencodeRuntime(rt OpencodeRuntime) { h.opencode = rt }

// launchCommand builds an agent's launch line. An opencode agent first gets its own server: the TUI attaches to it, and its password reaches the pane only through a private file.
func (h *SessionsHandler) launchCommand(ctx context.Context, ag agent.Agent, p agent.LaunchParams) (string, error) {
	if ag.AgentType() == at.Opencode {
		if h.opencode == nil {
			return "", fmt.Errorf("opencode: Coral's opencode server is not available")
		}
		srv, err := h.opencode.Ensure(ctx, p.SessionID, p.CLIPath)
		if err != nil {
			return "", err
		}
		file, err := srv.PasswordFile()
		if err != nil {
			h.opencode.Stop(p.SessionID)
			return "", err
		}
		p.OpencodeURL, p.OpencodePasswordFile = srv.URL, file
	}
	return launchCommand(ag, p)
}

// opencodeTurn is an opencode agent's turn as applyTranscriptState reads it: "prompt_submit" while a turn is going on, "stop" once it ended, "permission_request" while it waits for the person.
func (h *SessionsHandler) opencodeTurn(sessionID string) (kind string, at time.Time) {
	if h.opencode == nil {
		return "", time.Time{}
	}
	state, when, ok := h.opencode.AgentTurn(sessionID)
	if !ok {
		return "", time.Time{}
	}
	switch state {
	case opencode.StateWorking:
		return "prompt_submit", when
	case opencode.StateNeedsInput:
		return "permission_request", when
	case opencode.StateIdle, opencode.StateFailed:
		return "stop", when
	}
	return "", time.Time{}
}

// stopOpencode ends an agent's opencode server when the agent ends, sleeps, is archived or is replaced by a restart: one opencode process per live agent, never one left behind (the Mac ran out of processes).
func (h *SessionsHandler) stopOpencode(sessionID string) {
	if h.opencode != nil && sessionID != "" {
		h.opencode.Stop(sessionID)
	}
}

// OpencodeAlive says whether an opencode server's agent should still have one: its row is there, awake and not archived. A failed read says yes: nothing is stopped on a guess.
func (h *SessionsHandler) OpencodeAlive(key string) bool {
	if h.ss == nil {
		return true
	}
	ls, err := h.ss.GetLiveSession(context.Background(), key)
	if err != nil {
		return true
	}
	return ls != nil && ls.IsSleeping != 1 && ls.IsArchived != 1
}
