package routes

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #21285 (generation 16): the owner signed in at the self-hosted Hub reads a remote's saved messages with a stamp, so the remote sees a person and has nothing to warn about. A Hub that cannot stamp (it holds
// no secret, or the remote is from before generation 16) still reads them with its key in this release, and the remote warns (a later release refuses). A script with the key alone is served and warned too.
func TestTheOwnerAtTheHubReadsASavedListStampedAndAKeyAloneIsWarned(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "saved.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	cfg := &config.Config{LogDir: t.TempDir()}
	cfg.UseCoralDir(t.TempDir())
	h := NewSystemHandler(db, cfg)
	build := func(gen int, hubSecret string) *stampWorld {
		mount := func(rr chi.Router) {
			rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": gen})
			})
			rr.Get("/api/saved", h.SavedList)
		}
		return newStampWorldMount(t, hubSecret, integrationSecret, mount)
	}
	read := func(w *stampWorld, mutate func(*http.Request)) int {
		req, _ := http.NewRequest("GET", w.hub.URL+"/api/remote/ssh-box/api/saved", nil)
		mutate(req)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		assert.Empty(t, resp.Header.Get(hubowner.KeyReadNoticeHeader), "the Hub keeps the remote's notice off the page")
		return resp.StatusCode
	}
	none := func(*http.Request) {}
	key := func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") }
	warned := func(buf interface{ String() string }) bool {
		return strings.Contains(buf.String(), "a Hub read private data")
	}

	buf := captureLog(t)
	w := build(hubowner.RoutesVersion, integrationSecret)
	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	assert.Equal(t, http.StatusOK, read(w, none), "the owner at the Hub reads the saved list")
	assert.False(t, warned(buf), "stamped: a person, nothing to warn about")
	assert.Equal(t, http.StatusOK, read(w, key), "a script with the key is still served in this release")
	assert.True(t, warned(buf), "and warned")

	buf = captureLog(t)
	w2 := build(hubowner.RoutesVersion, "") // a Hub with no Approve set up cannot sign
	*w2.cookie = true
	assert.Equal(t, http.StatusOK, read(w2, none), "served by the key alone")
	assert.True(t, warned(buf), "and warned: it needs Approve through the hub")

	buf = captureLog(t)
	w3 := build(15, integrationSecret) // a remote from before generation 16 lists nothing to stamp
	*w3.cookie = true
	assert.Equal(t, http.StatusOK, read(w3, none))
	assert.True(t, warned(buf), "an older remote is warned about too")
}
