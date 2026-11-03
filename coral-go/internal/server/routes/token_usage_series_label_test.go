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

// The cost chart grouped by team names a team, not its board id (#13045, found on the demo: the legend, the end label and the tooltip said b-6xccqbikbn for a team launched from the dashboard). A series
// keeps its key (the board id, which the chart joins on and the By team table's rows check) and carries the team's current label, as the By team rows do (#10936): a board renamed later shows its new
// name; a board with no row, a usage row with no team and a server with no board store show the key. The other groupings name themselves already and are left as they are.
func TestTimeseriesGroupedByTeamCarriesTheTeamsLabel(t *testing.T) {
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
	at := time.Now().UTC().Add(-time.Hour) // relative to now, never a fixed date
	for _, board := range []string{named.ID, "b-no-board-row"} {
		board := board
		require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: "s-" + board, AgentName: "agent-" + board, AgentType: "claude", BoardName: &board, Model: "claude-opus-5-5", Source: "jsonl", InputTokens: 100, OutputTokens: 10, CostUSD: 0.5, RecordedAt: at.Format(time.RFC3339Nano)}))
	}
	h := NewTokenUsageHandler(db)
	h.SetBoardStore(bs)
	bare := NewTokenUsageHandler(db) // no board store
	r := chi.NewRouter()
	r.Get("/api/token-usage/timeseries", h.UsageTimeSeries)
	r.Get("/api/token-usage/timeseries-bare", bare.UsageTimeSeries)

	type series struct {
		Key   string `json:"key"`
		Label string `json:"label"`
	}
	labels := func(path string) map[string]string {
		var body struct {
			Buckets []struct {
				Series []series `json:"series"`
			} `json:"buckets"`
		}
		require.Equal(t, http.StatusOK, seriesGet(t, r, path, false, &body))
		out := map[string]string{}
		for _, b := range body.Buckets {
			for _, s := range b.Series {
				out[s.Key] = s.Label
			}
		}
		return out
	}
	got := labels("/api/token-usage/timeseries?interval=1h&group_by=team")
	assert.Equal(t, "phone-pass", got[named.ID], "a team's series says the team's name; its key stays the board id")
	assert.Equal(t, "b-no-board-row", got["b-no-board-row"], "a board with no row shows its key")

	require.NoError(t, bs.RenameBoard(ctx, named.ID, "renamed-team"))
	assert.Equal(t, "renamed-team", labels("/api/token-usage/timeseries?interval=1h&group_by=team")[named.ID], "a board renamed later shows its current name")
	assert.Equal(t, named.ID, labels("/api/token-usage/timeseries-bare?interval=1h&group_by=team")[named.ID], "with no board store the label is the key, never empty")

	agents := labels("/api/token-usage/timeseries?interval=1h&group_by=agent")
	for key, label := range agents {
		assert.Equal(t, key, label, "an agent's series is named by its key already")
	}
	assert.NotEmpty(t, agents)
}
