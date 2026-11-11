package routes

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store/storetest"
	"net/http/httptest"
)

// #15645: a file an agent shares moves the artifact revisions, and the Inbox's Artifacts count follows the revision feed. The feed ticks every 5 s,
// so the revision has to be on /ws/coral at once (a kick), not at the next tick: with the poll interval at 10 s and the test clear of the tick, a
// coral_diff carrying the team's new revision arrives well inside a second.
func TestWSCoral_ArtifactRevisionReachesTheFeedAtOnce(t *testing.T) {
	cfg := &config.Config{WSPollInterval: 10 * time.Second, LogDir: t.TempDir()}
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	handler := NewSessionsHandler(db, cfg, nil, ptymanager.NewPTYSessionTerminal(ptymanager.NewPTYBackend()), bs)
	r := chi.NewRouter()
	r.Get("/ws/coral", handler.WSCoral)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+server.URL[4:]+"/ws/coral", nil)
	require.NoError(t, err)
	t.Cleanup(func() { conn.CloseNow() })
	var first map[string]any
	require.NoError(t, wsjson.Read(ctx, conn, &first))
	clearOfTick(cfg.WSPollInterval, 3*time.Second)

	before := bs.ArtifactsRevision("team-a")
	bs.NoteArtifactsChanged("team-a")
	start := time.Now()
	readCtx, stop := context.WithTimeout(ctx, 2*time.Second)
	defer stop()
	for {
		var msg struct {
			Rev map[string]uint64 `json:"artifacts_rev"`
		}
		require.NoError(t, wsjson.Read(readCtx, conn, &msg), "no coral_diff with the team's new artifact revision before the tick")
		if msg.Rev["team-a"] > before {
			require.Less(t, time.Since(start), 500*time.Millisecond)
			return
		}
	}
}
