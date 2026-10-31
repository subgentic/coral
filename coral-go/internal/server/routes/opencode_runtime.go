package routes

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/opencode"
)

// OpencodeRuntime is what an opencode agent needs of the server Coral runs for it (opencode.Manager): the server started for the agent (Ensure), the state its event stream gave (AgentTurn), and the end of
// both with the agent (Stop). The key is the agent's Coral session id.
type OpencodeRuntime interface {
	Ensure(ctx context.Context, key, bin, model, resume string) (OpencodeServer, error)
	AgentTurn(key string) (opencode.State, time.Time, bool)
	AgentMessages(ctx context.Context, key string) ([]opencode.Message, bool, error)
	UseSession(key, session string)
	AgentLastMessage(key string) (opencode.Message, bool)
	Stop(key string)
}

// OpencodeServer is what a launch needs of an agent's server: where the TUI attaches, the major version of the build (it decides the attach form and the password variable), and the private file the password is
// read from.
type OpencodeServer interface {
	ServerURL() string
	ServerMajor() int
	PasswordFile() (string, error)
}

// managerRuntime is the opencode.Manager as an OpencodeRuntime: Ensure answers with the interface a launch uses.
type managerRuntime struct{ *opencode.Manager }

func (m managerRuntime) Ensure(ctx context.Context, key, bin, model, resume string) (OpencodeServer, error) {
	srv, err := m.Manager.Ensure(ctx, key, bin, model, resume)
	if err != nil {
		return nil, err
	}
	return managerServer{srv}, nil
}

type managerServer struct{ *opencode.Server }

func (s managerServer) ServerURL() string { return s.URL }
func (s managerServer) ServerMajor() int  { return s.Version.Major }

// OpencodeRuntimeOf is the manager as the runtime the sessions handler takes.
func OpencodeRuntimeOf(m *opencode.Manager) OpencodeRuntime { return managerRuntime{m} }

// SetOpencodeRuntime gives the sessions handler the opencode server manager; nil until the server wires it, and an opencode agent then cannot be launched.
func (h *SessionsHandler) SetOpencodeRuntime(rt OpencodeRuntime) { h.opencode = rt }

// launchCommand builds an agent's launch line. An opencode agent first gets its own server: the TUI attaches to it, and its password reaches the pane only through a private file.
func (h *SessionsHandler) launchCommand(ctx context.Context, ag agent.Agent, p agent.LaunchParams) (string, error) {
	if ag.AgentType() == at.Opencode {
		if h.opencode == nil {
			return "", fmt.Errorf("opencode: Coral's opencode server is not available")
		}
		srv, err := h.opencode.Ensure(ctx, p.SessionID, p.CLIPath, modelFromFlags(p.Flags), p.ResumeSessionID)
		if err != nil {
			return "", err
		}
		file, err := srv.PasswordFile()
		if err != nil {
			h.opencode.Stop(p.SessionID)
			return "", err
		}
		p.OpencodeURL, p.OpencodePasswordFile, p.OpencodeMajor = srv.ServerURL(), file, srv.ServerMajor()
		h.useResumedSession(p)
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

// opencodeLastMessage is an opencode agent's newest message as the list shows it: what its server's last turn gave, kept by the manager (the list never calls the server).
func (h *SessionsHandler) opencodeLastMessage(sessionID string) (jsonl.LastMessage, bool) {
	if h.opencode == nil {
		return jsonl.LastMessage{}, false
	}
	m, ok := h.opencode.AgentLastMessage(sessionID)
	if !ok {
		return jsonl.LastMessage{}, false
	}
	// one line, as the transcript readers give it; not cut here: lastMessageField redacts it and then shows its first characters, so a secret is never cut in two before it is looked for
	return jsonl.LastMessage{Role: m.Role, Text: strings.Join(strings.Fields(m.Text), " "), At: m.At}, true
}

// opencodeTranscript is an opencode agent's chat: its newest session's messages from its server, in the shape the chat reads (what was said, by the person and by the agent; tool rows are not kept by the API's
// message list). Empty, not an error, when the agent has no server or no session yet: the chat shows a new agent's empty history.
func (h *SessionsHandler) opencodeTranscript(ctx context.Context, sessionID string) *jsonl.Transcript {
	var out []map[string]any
	if h.opencode != nil {
		if msgs, ok, err := h.opencode.AgentMessages(ctx, sessionID); err == nil && ok {
			for _, m := range msgs {
				entry := map[string]any{"type": m.Role, "timestamp": opencodeTime(m.At), "content": m.Text}
				if m.Role == "assistant" {
					entry["text"], entry["tool_uses"] = m.Text, []map[string]any{}
				}
				out = append(out, entry)
			}
		}
	}
	return jsonl.NewMemoryTranscript(out)
}

// opencodeTime is a message's time as RFC 3339: the server may send epoch milliseconds, which the chat does not read.
func opencodeTime(at string) string {
	if ms, err := strconv.ParseInt(at, 10, 64); err == nil && ms > 0 {
		return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
	}
	return at
}

// useResumedSession gives the manager the opencode session a resumed agent is picking up, so its chat and last message are there at once: after a Coral restart the stream has said nothing yet.
func (h *SessionsHandler) useResumedSession(p agent.LaunchParams) {
	if h.opencode != nil && agent.IsOpencodeSessionID(p.ResumeSessionID) {
		h.opencode.UseSession(p.SessionID, p.ResumeSessionID)
	}
}

// modelFromFlags is the model a launch asks for: the value of --model (or -m, or --model=value) in the flags, the last one given; "" when there is none or it is not one opencode's config takes.
func modelFromFlags(flags []string) string {
	model := ""
	for i := 0; i < len(flags); i++ {
		f := flags[i]
		switch {
		case (f == "--model" || f == "-m") && i+1 < len(flags):
			model = flags[i+1]
			i++
		case strings.HasPrefix(f, "--model="):
			model = strings.TrimPrefix(f, "--model=")
		}
	}
	if !opencode.ValidModel(model) {
		return ""
	}
	return model
}
