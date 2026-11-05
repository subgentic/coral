package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #13609: every route in the table writes its row, for a person only, after a 2xx answer. The handler here is a stand-in that answers with the status the case names, so the test is of the recorder and the table
// (the real handlers of the main ones are driven end to end in internal/server's activity_clicks_e2e_test.go).
func TestEveryRecordedRouteWritesItsRowForAPersonOnly(t *testing.T) {
	require.NotEmpty(t, activityRoutes)
	for key, want := range activityRoutes {
		method, pattern, _ := strings.Cut(key, " ")
		for _, c := range []struct {
			name    string
			person  bool
			status  int
			wantRow bool
		}{
			{"a person's click", true, http.StatusOK, true},
			{"an agent's call", false, http.StatusOK, false},
			{"a refused call", true, http.StatusForbidden, false},
			{"a failed call", true, http.StatusInternalServerError, false},
		} {
			bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
			require.NoError(t, err)
			r := chi.NewRouter()
			r.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					if c.person {
						req = asPerson(req)
					}
					next.ServeHTTP(w, req)
				})
			})
			r.Use(ActivityRecorder(bs))
			status := c.status
			r.MethodFunc(method, pattern, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
			path := strings.NewReplacer("{project}", "p", "{taskID}", "7", "{name}", "agent-1").Replace(pattern)
			req := httptest.NewRequest(method, path, nil)
			r.ServeHTTP(httptest.NewRecorder(), req)
			rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
			require.NoError(t, err)
			if !c.wantRow {
				assert.Empty(t, rows, "%s: %s", key, c.name)
			} else if assert.Len(t, rows, 1, "%s: %s", key, c.name) {
				assert.Equal(t, want.Action, rows[0].Action, key)
				assert.Equal(t, want.Kind, rows[0].ItemKind, key)
				assert.Equal(t, "local", rows[0].Actor, key)
				if want.ID != "" {
					assert.NotEmpty(t, rows[0].ItemID, key)
				}
				if want.Team != "" {
					assert.Equal(t, "p", rows[0].Team, key)
				}
			}
			bs.Close()
		}
	}
}

// A read is never an action: a GET on a listed path (there is none today) and a route that is not in the table write nothing.
func TestARouteOutsideTheTableWritesNothing(t *testing.T) {
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { next.ServeHTTP(w, asPerson(req)) })
	})
	r.Use(ActivityRecorder(bs))
	r.Post("/api/board/{project}/tasks/{taskID}/something-new", func(w http.ResponseWriter, _ *http.Request) {})
	r.Get("/api/board/{project}/tasks/{taskID}", func(w http.ResponseWriter, _ *http.Request) {})
	for _, req := range []*http.Request{httptest.NewRequest("POST", "/api/board/p/tasks/7/something-new", nil), httptest.NewRequest("GET", "/api/board/p/tasks/7", nil)} {
		r.ServeHTTP(httptest.NewRecorder(), req)
	}
	rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
	require.NoError(t, err)
	assert.Empty(t, rows)
}

// Through Coral Hub the owner's click is a row too, from "hub", by the Hub account's label; a forged stamp is nobody's click (humanInputCaller checks the connector's own secret).
func TestARecordedRouteThroughTheHubIsTheOwnersRowAndAForgedStampIsNone(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil)
	for name, c := range map[string]struct {
		hdr     map[string]string
		wantRow bool
	}{
		"the owner's stamp": {map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}, true},
		"a forged stamp":    {map[string]string{tunnel.ViaHeader: "not-the-secret", tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}, false},
	} {
		bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
		require.NoError(t, err)
		r := chi.NewRouter()
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerHub)))
			})
		})
		r.Use(ActivityRecorder(bs))
		r.Post("/api/board/{project}/tasks/{taskID}/cancel", func(w http.ResponseWriter, _ *http.Request) {})
		req := httptest.NewRequest("POST", "/api/board/p/tasks/7/cancel", nil)
		for k, v := range c.hdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(httptest.NewRecorder(), req)
		rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
		require.NoError(t, err)
		if !c.wantRow {
			assert.Empty(t, rows, name)
		} else if assert.Len(t, rows, 1, name) {
			assert.Equal(t, board.ActTaskCancel, rows[0].Action, name)
			assert.Equal(t, "hub", rows[0].Source, name)
			assert.True(t, strings.HasPrefix(rows[0].Actor, "hub:"), name)
		}
		bs.Close()
	}
}
