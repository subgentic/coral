package routes

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// Analytics > Cost by team names a team by its label, not its board id (#10936, the phone pass: a row said b-6xccqbikbn for "phone-pass"). Each by-team row carries board_label: the board's current label, so a board renamed
// later shows its new name; a board with no row, and a server with no board store, show the id.
func TestByTeamRowsCarryTheTeamsCurrentLabel(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "usage.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := t.Context()
	named, err := bs.CreateBoard(ctx, "phone-pass", "test")
	require.NoError(t, err)
	require.NotEqual(t, "phone-pass", named.ID, "the id is not the name: the bug is only visible then")

	ts := store.NewTokenUsageStore(db)
	at := time.Now().UTC().Add(-time.Hour)
	for _, board := range []string{named.ID, "b-no-board-row"} {
		board := board
		require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: "s-" + board, AgentName: "a", AgentType: "claude", BoardName: &board, Model: "claude-opus-5-5", Source: "jsonl", InputTokens: 100, OutputTokens: 10, CostUSD: 0.5, RecordedAt: at.Format(time.RFC3339Nano)}))
	}
	h := NewTokenUsageHandler(db)
	h.SetBoardStore(bs)
	r := chi.NewRouter()
	r.Get("/api/token-usage/by-team", h.UsageSummaryByBoard)
	bare := NewTokenUsageHandler(db) // no board store
	r.Get("/api/token-usage/by-team-bare", bare.UsageSummaryByBoard)

	labels := func(path string) map[string]string {
		var body struct {
			Teams []struct {
				BoardName  string `json:"board_name"`
				BoardLabel string `json:"board_label"`
			} `json:"teams"`
		}
		require.Equal(t, http.StatusOK, seriesGet(t, r, path, false, &body))
		out := map[string]string{}
		for _, tm := range body.Teams {
			out[tm.BoardName] = tm.BoardLabel
		}
		return out
	}
	got := labels("/api/token-usage/by-team")
	assert.Equal(t, "phone-pass", got[named.ID], "a team row says the team's name")
	assert.Equal(t, "b-no-board-row", got["b-no-board-row"], "a board with no row shows its id")

	require.NoError(t, bs.RenameBoard(ctx, named.ID, "renamed-team"))
	assert.Equal(t, "renamed-team", labels("/api/token-usage/by-team")[named.ID], "a board renamed later shows its current name")

	assert.Equal(t, named.ID, labels("/api/token-usage/by-team-bare")[named.ID], "with no board store the row carries the id, never an empty label")
}
