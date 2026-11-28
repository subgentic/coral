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

	"github.com/subgentic/coral/internal/config"
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
	bootAt := func(target string) map[string]any {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, target, nil)
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
	boot := func() map[string]any { return bootAt("/") }

	// The page says it only when the notice will draw (#22033): unseen, the default is Auto, and a live agent exists. A row reserved for a notice that never comes would have to be given back, and giving it back moves the page.
	assert.NotContains(t, boot(), "launch_unseen", "unseen but no agent on this computer: no notice will draw, so no row is reserved")
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "11111111-1111-4111-8111-111111111111", AgentType: "claude", AgentName: "dev", WorkingDir: t.TempDir()}))
	assert.Equal(t, true, boot()["launch_unseen"], "nothing acknowledged and an agent exists: the page says the notice is unseen")

	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "default"))
	assert.NotContains(t, boot(), "launch_unseen", "the saved default is not Auto: the notice is hidden, so nothing is reserved")
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "auto"))
	assert.Equal(t, true, boot()["launch_unseen"], "Auto again: reserved again")

	ack, _ := json.Marshal(map[string]string{"id": routes.LaunchDisclosureID, "at": time.Now().UTC().Format(time.RFC3339)})
	require.NoError(t, ss.SetSetting(ctx, settings.LaunchDisclosureAck, string(ack)))
	assert.NotContains(t, boot(), "launch_unseen", "acknowledged: the page does not say it (and is not the cached unseen page)")

	stale, _ := json.Marshal(map[string]string{"id": "an-older-text", "at": time.Now().UTC().Format(time.RFC3339)})
	require.NoError(t, ss.SetSetting(ctx, settings.LaunchDisclosureAck, string(stale)))
	assert.Equal(t, true, boot()["launch_unseen"], "an acknowledgement of other words does not count: unseen again")
}

// The dashboard suites stand in for the live agent row with ?test_agent=1, and only a dev build with CORAL_TEST_HOOKS=1 reads it: a release build (TestHooksEnvHonoured is a constant false there) ignores it, so no page can ask for a reserved row it will not fill.
func TestIndexLaunchNoticeTestAgentFlagIsDevOnly(t *testing.T) {
	t.Setenv("CORAL_TEST_HOOKS", "1")
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/?test_agent=1", nil)
	req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000"
	srv.Router().ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	b, _ := io.ReadAll(rec.Result().Body)
	says := strings.Contains(string(b), `"launch_unseen":true`)
	assert.Equal(t, config.TestHooksEnvHonoured, says, "no agent row exists: only a dev build with the hooks on takes the test flag as one")
}
