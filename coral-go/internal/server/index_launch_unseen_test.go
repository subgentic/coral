package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The dashboard page says, in its boot data, when the first-launch notice is unseen (#14935), so the page reserves the notice's room before first paint on a profile that holds no hint:
// without it the notice, read after first paint, pushed the page down by its height on the very first load. It is a fact about this computer, the same for every viewer (no secret, no per-request value),
// so the page is cached apart while it holds and the page carries it only while the current words are not acknowledged.
func TestIndexSaysWhenTheLaunchNoticeIsUnseen(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	boot := func() map[string]any {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000"
		srv.Router().ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		b, _ := io.ReadAll(rec.Result().Body)
		page := string(b)
		const open = `<script type="application/json" id="coral-boot">`
		i := strings.Index(page, open)
		require.GreaterOrEqual(t, i, 0, "the boot data is in the page")
		rest := page[i+len(open):]
		j := strings.Index(rest, `</script>`)
		require.GreaterOrEqual(t, j, 0)
		var out map[string]any
		require.NoError(t, json.Unmarshal([]byte(rest[:j]), &out))
		return out
	}

	assert.Equal(t, true, boot()["launch_unseen"], "nothing acknowledged: the page says the notice is unseen")

	ack, _ := json.Marshal(map[string]string{"id": routes.LaunchDisclosureID, "at": time.Now().UTC().Format(time.RFC3339)})
	require.NoError(t, ss.SetSetting(ctx, settings.LaunchDisclosureAck, string(ack)))
	assert.NotContains(t, boot(), "launch_unseen", "acknowledged: the page does not say it (and is not the cached unseen page)")

	stale, _ := json.Marshal(map[string]string{"id": "an-older-text", "at": time.Now().UTC().Format(time.RFC3339)})
	require.NoError(t, ss.SetSetting(ctx, settings.LaunchDisclosureAck, string(stale)))
	assert.Equal(t, true, boot()["launch_unseen"], "an acknowledgement of other words does not count: unseen again")
}
