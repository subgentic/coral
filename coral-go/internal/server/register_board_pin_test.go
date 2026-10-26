package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

const boardSurfaceGolden = "testdata/register_board_routes.golden"

// Pin actual endpoints, not registration source text: changing a method, path or
// handler must fail even when the route is still present in a wider API census.
func TestRegisterBoardPinsActualRouteBindings(t *testing.T) {
	srv, _, _ := strictServer(t, true)
	var surface []string
	require.NoError(t, chi.Walk(srv.Router(), func(method, path string, handler http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !boardSurfacePath(path) {
			return nil
		}
		value := reflect.ValueOf(handler)
		require.Equal(t, reflect.Func, value.Kind(), "%s %s endpoint", method, path)
		name := runtime.FuncForPC(value.Pointer()).Name()
		name = strings.TrimPrefix(name, "github.com/subgentic/coral/internal/server/routes.")
		surface = append(surface, method+" "+path+" | "+name)
		return nil
	}))
	sort.Strings(surface)
	require.Greater(t, len(surface), 80, "the walk must cover the whole board registration")
	got := strings.Join(surface, "\n") + "\n"
	if os.Getenv("UPDATE_BOARD_ROUTE_GOLDEN") == "1" {
		require.NoError(t, os.MkdirAll(filepath.Dir(boardSurfaceGolden), 0755))
		require.NoError(t, os.WriteFile(boardSurfaceGolden, []byte(got), 0644))
	}
	want, err := os.ReadFile(boardSurfaceGolden)
	require.NoError(t, err)
	require.Equal(t, string(want), got)
}

func boardSurfacePath(path string) bool {
	return strings.HasPrefix(path, "/api/board/") || strings.HasPrefix(path, "/api/tasks/") || path == "/api/notifications" || path == "/api/session-artifacts" || path == "/api/team-artifacts" || path == "/api/cloud/cross-team-links" || path == "/api/goals" || path == "/api/goal-links"
}

// Every board-dependent method must retain its 503 guard after extraction, not
// only the three GETs exercised by the older nil-board smoke test.
func TestRegisterBoardPinsUnavailableStoreBoundary(t *testing.T) {
	srv := newNilBoardServer(t)
	router := srv.Router()
	raw, err := os.ReadFile(boardSurfaceGolden)
	require.NoError(t, err)
	parameter := regexp.MustCompile(`\{[^}]+\}`)
	guarded := 0
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		binding, _, _ := strings.Cut(line, " | ")
		method, path, _ := strings.Cut(binding, " ")
		needsBoard := strings.HasPrefix(path, "/api/board/") && !strings.HasPrefix(path, "/api/board/remotes") && path != "/api/board/{project}/status"
		needsBoard = needsBoard || path == "/api/cloud/cross-team-links" || path == "/api/goals" || path == "/api/goal-links"
		if !needsBoard {
			continue
		}
		guarded++
		t.Run(binding, func(t *testing.T) {
			req := httptest.NewRequest(method, parameter.ReplaceAllString(path, "1"), strings.NewReader(`{}`))
			req.Header.Set("Authorization", "Bearer "+srv.keyStore.Key())
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
			require.JSONEq(t, `{"error":"board unavailable","code":"board_unavailable"}`, rec.Body.String())
		})
	}
	require.Greater(t, guarded, 70)
	for _, path := range []string{"/api/session-artifacts", "/api/board/remotes"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+srv.keyStore.Key())
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.NotEqual(t, http.StatusServiceUnavailable, rec.Code, path)
	}
}
