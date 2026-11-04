package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13361 (#13292): the server reads every session's upload records in the background right after it is built, so the first artifacts read finds them cached (router_board.go calls BoardHandler.WarmUploads).
// Pinned here because the line that makes the call is in the router, out of the sight of the cache's own tests: a server that never calls it reads none of these files until a request asks.
func TestTheServerReadsEveryUploadRecordInTheBackgroundAtStartUp(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	old := time.Now().Add(-time.Hour)
	const sessions, perSession = 3, 13
	for s := 0; s < sessions; s++ {
		dir := filepath.Join(cfg.CoralDir(), "artifacts", "uploads", fmt.Sprintf("warm-sess-%d", s))
		require.NoError(t, os.MkdirAll(dir, 0o755))
		for i := 0; i < perSession; i++ {
			id := fmt.Sprintf("%064x", s*100+i+1)
			rec, _ := json.Marshal(map[string]any{"name": fmt.Sprintf("f%d.md", i), "media_type": "text/markdown", "size": 3, "digest": "sha256:" + id, "created_at": "2026-10-01T10:00:00Z"})
			p := filepath.Join(dir, id+".json")
			require.NoError(t, os.WriteFile(p, rec, 0o644))
			require.NoError(t, os.Chtimes(p, old, old))
		}
		require.NoError(t, os.Chtimes(dir, old, old))
	}
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	before := routes.UploadRecordReads()
	newTestServer(t, cfg, db, stack.backend, stack.terminal)
	require.Eventually(t, func() bool { return routes.UploadRecordReads()-before >= sessions*perSession }, 10*time.Second, 20*time.Millisecond,
		"every record was read with no request made (reads since the server was built: %d of %d)", routes.UploadRecordReads()-before, sessions*perSession)
}
