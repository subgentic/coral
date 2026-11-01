package routes

import (
	"context"
	"errors"
	"log/slog"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/hermesdb"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// hermesChatRows is the most recent rows of a session one chat read takes (the reader bounds a read at hermesdb.MaxMessages; a chat needs fewer).
const hermesChatRows = 2000

// hermesTranscript is a Hermes agent's chat (#11831): the rows of the Hermes session its hooks bound to this Coral session (transcriptlink.HermesSession), read from the state.db of the session's TEAM home only
// (agent.HermesTeamHome: a session's team decides the folder, so another team's rows are never asked for), read-only and by that one session id (hermesdb). No link yet, no state.db, a layout Coral does not read or a
// failed read is an empty chat, never an error to the person: Hermes may not have run a turn, and a newer Hermes may have changed its tables.
func (h *SessionsHandler) hermesTranscript(ctx context.Context, sessionID string) *jsonl.Transcript {
	empty := jsonl.NewMemoryTranscript(nil)
	if h.cfg == nil || !transcriptlink.IsSessionID(sessionID) {
		return empty
	}
	dataDir := h.cfg.CoralDir()
	hermesID := transcriptlink.HermesSession(dataDir, sessionID)
	if hermesID == "" {
		return empty
	}
	team := ""
	if ls, err := h.ss.GetLiveSession(ctx, sessionID); err == nil && ls != nil && ls.BoardName != nil {
		team = *ls.BoardName
	}
	db, err := hermesdb.Open(agent.HermesTeamHome(dataDir, team))
	if err != nil {
		if !errors.Is(err, hermesdb.ErrNoStore) {
			slog.Debug("hermes: state.db not read", "error", err)
		}
		return empty
	}
	defer db.Close()
	rows, err := db.Messages(ctx, hermesID, 0, hermesChatRows)
	if err != nil {
		slog.Debug("hermes: messages not read", "error", err)
		return empty
	}
	return jsonl.NewMemoryTranscript(jsonl.ParseHermesMessages(rows))
}
