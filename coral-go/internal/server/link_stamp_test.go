package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// testLinkID is the link the tests' requests arrive on unless one names another.
const testLinkID = "lnk-00000001"

func init() {
	routerTestWrap = func(db *store.DB) func(http.Handler) http.Handler {
		// Seeded for each connector request: a test that saves an enrollment replaces the links (a new enrollment is a new link), and its requests still arrive on a link.
		seed := func() {
			_, _ = db.ExecContext(context.Background(), `INSERT OR IGNORE INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, created_at)
				VALUES (?, 'https://test.invalid', 'srv_test', 'test', '', 'active', 'launch', '2026-01-01T00:00:00Z')`, testLinkID)
		}
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if cloud.TunneledAuthentic(r) {
					if r.Header.Get(tunnel.LinkHeader) == testLinkID || len(r.Header.Values(tunnel.LinkHeader)) == 0 {
						seed()
					}
					if len(r.Header.Values(tunnel.LinkHeader)) == 0 {
						r.Header.Set(tunnel.LinkHeader, testLinkID)
					}
				}
				next.ServeHTTP(w, r)
			})
		}
	}
}

// #20312 on the real router: a request the connector stamped with a link this computer does not have is refused before any handler, and one with a known link is served.
func TestTheRealRouterRefusesAConnectorRequestWithAStaleLink(t *testing.T) {
	cfg := newE2EConfig(t, t.TempDir())
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	srv := newTestServer(t, cfg, db, nil, nil)
	h := srv.Router()
	_, err = db.ExecContext(context.Background(), `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, created_at)
		VALUES ('lnk-0a0b0c0d', 'https://real.invalid', 'srv_real', 'real', '', 'active', 'view', '2026-01-01T00:00:00Z')`)
	require.NoError(t, err)
	get := func(link string) (int, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		req.Header.Set(tunnel.LinkHeader, link)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}
	for _, bad := range []string{"lnk-deadbeef", "not-a-link"} {
		code, body := get(bad)
		assert.Equal(t, http.StatusForbidden, code, bad)
		assert.Contains(t, body, cloud.LinkRefusedCode, bad)
	}
	_, body := get("lnk-0a0b0c0d")
	assert.NotContains(t, body, cloud.LinkRefusedCode, "a known link is not refused for its link")
	// Security's point 8: a paused, revoked or removing link is refused too, and an active one is served again.
	for _, st := range []string{"paused", "revoked", "removing"} {
		_, err = db.ExecContext(context.Background(), "UPDATE cloud_link SET state = ? WHERE link_id = 'lnk-0a0b0c0d'", st)
		require.NoError(t, err)
		code, body := get("lnk-0a0b0c0d")
		assert.Equal(t, http.StatusForbidden, code, st)
		assert.Contains(t, body, cloud.LinkRefusedCode, st)
	}
	_, err = db.ExecContext(context.Background(), "UPDATE cloud_link SET state = 'active' WHERE link_id = 'lnk-0a0b0c0d'")
	require.NoError(t, err)
	_, body = get("lnk-0a0b0c0d")
	assert.NotContains(t, body, cloud.LinkRefusedCode)
	require.NotNil(t, routerTestWrap)
}
