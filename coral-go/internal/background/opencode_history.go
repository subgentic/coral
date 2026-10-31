package background

import (
	"context"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/opencode"
)

// OpencodeSessions is what the history source needs of the opencode manager.
type OpencodeSessions interface {
	Keys() []string
	AgentSession(key string) (opencode.State, time.Time, bool)
	AgentMessages(ctx context.Context, key string) ([]opencode.Message, bool, error)
}

// OpencodeHistory is the indexer's source for opencode agents (#11383): their conversations through their servers' message API, never opencode's own database and never a path the server names. The cost is held
// down three ways: an agent whose session has not changed since the last pass is not read at all (its last change, from the event stream, is the row's time); an agent that is working is left for the pass after its
// turn ends; and a read goes through the manager's own bounds (at most one a few seconds, 16 MiB of text, 200 KB a message).
type OpencodeHistory struct{ m OpencodeSessions }

func NewOpencodeHistory(m OpencodeSessions) *OpencodeHistory { return &OpencodeHistory{m: m} }

// ExtractLive implements LiveSource.
func (h *OpencodeHistory) ExtractLive(ctx context.Context, known map[string]float64) []agent.IndexedSession {
	var out []agent.IndexedSession
	for _, key := range h.m.Keys() {
		if ctx.Err() != nil {
			break
		}
		state, at, ok := h.m.AgentSession(key)
		if !ok || state == opencode.StateWorking {
			continue // no session at all yet, or a turn going on: its row waits for the turn to end
		}
		mtime := float64(at.UnixNano()) / 1e9
		if last, seen := known[agent.OpencodeSourcePrefix+key]; seen && last >= mtime {
			continue // unchanged since the last pass: nothing is read
		}
		msgs, ok, err := h.m.AgentMessages(ctx, key)
		if err != nil || !ok || len(msgs) == 0 {
			continue
		}
		hist := make([]agent.OpencodeHistoryMessage, len(msgs))
		for i, m := range msgs {
			hist[i] = agent.OpencodeHistoryMessage{Role: m.Role, Text: m.Text, At: m.At}
		}
		out = append(out, *agent.IndexOpencodeSession(key, hist, mtime))
	}
	return out
}
