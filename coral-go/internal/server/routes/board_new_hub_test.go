package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// A board comes into being the first time something names it. Through Coral Hub that is the owner's alone (#11627, Security's SHOULD on #11626): a guest or grantee naming a board that does not exist
// is refused on every route that would make it, whatever the tier; the owner, this computer and a board that already exists are unchanged.
func TestNewBoardThroughTheHubIsTheOwnersAlone(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	old := hubOwnerLabel
	const owner, guest = "hub-user-0000beef", "hub-user-1234abcd"
	hubOwnerLabel = func(context.Context) (string, error) { return owner, nil }
	t.Cleanup(func() { hubOwnerLabel = old })

	g := TunnelIdentityGuard(h.bs, func(*http.Request) bool { return true })
	router := chi.NewRouter()
	router.With(g).Post("/api/board/{project}/subscribe", h.Subscribe)
	router.With(g).Post("/api/board/{project}/messages", h.PostMessage)
	router.With(g).Post("/api/board/{project}/tasks", h.CreateTask)
	router.With(g).Post("/api/board/{project}/goals", h.CreateGoal)
	router.With(g).Put("/api/board/{project}/working-mode", h.SetWorkingMode)
	router.With(g).Post("/api/board/{project}/working-mode/presets", h.SaveWorkflowPreset)
	do := func(hub bool, user, role, route, body string) *httptest.ResponseRecorder {
		method := "POST"
		if strings.HasSuffix(route, "/working-mode") {
			method = "PUT"
		}
		r := httptest.NewRequest(method, route, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if hub {
			stamp(r)
			r.Header.Set(tunnel.HubUserHeader, user)
			if role != "" {
				r.Header.Set(tunnel.HubRoleHeader, role)
			}
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, r)
		return rec
	}
	// The census (#11627): the routes a Hub guest may call that store something under a board's name. Each is refused for a name no board has. Others need a task, a member or a message that exists already.
	routes := []struct{ name, path, body string }{
		{"mode", "working-mode", `{"mode":"worktrees"}`},
		{"preset", "working-mode/presets", `{"id":"p1","name":"P","instructions":"x"}`},
		{"subscribe", "subscribe", `{"subscriber_id":"Operator","job_title":"Operator"}`},
		{"message", "messages", `{"content":"hello"}`},
		{"task", "tasks", `{"title":"a task"}`},
		{"goal", "goals", `{"title":"a goal","done_when":"it is done"}`},
	}
	for _, rt := range routes {
		for _, role := range []string{"", "guest", "grantee"} {
			rec := do(true, guest, role, "/api/board/fresh-"+rt.name+"/"+rt.path, rt.body)
			assert.Equal(t, http.StatusForbidden, rec.Code, "%s as a non-owner (role %q) must not make a board: %s", rt.name, role, rec.Body.String())
			assert.Equal(t, "owner_only", codeOf(t, rec), "%s (role %q)", rt.name, role)
			exists, err := h.bs.BoardExists(ctx, "fresh-"+rt.name)
			require.NoError(t, err)
			assert.False(t, exists, "%s as a non-owner (role %q) left a board behind", rt.name, role)
			presets, err := h.bs.ListWorkflowPresets(ctx, "fresh-"+rt.name)
			require.NoError(t, err)
			for _, p := range presets {
				assert.False(t, p.ID == "p1", "%s as a non-owner (role %q) stored a preset under a new name", rt.name, role)
			}
			wm, err := h.bs.GetWorkingMode(ctx, "fresh-"+rt.name)
			require.NoError(t, err)
			assert.NotEqual(t, "worktrees", wm.Mode, "%s as a non-owner (role %q) stored a working mode under a new name", rt.name, role)
		}
	}

	// The owner writes under a new name (the working mode too); this computer too; this computer too; and a board that exists keeps working for the Hub user.
	rec := do(true, owner, tunnel.HubRoleOwner, "/api/board/owned/subscribe", routes[0].body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = do(true, owner, tunnel.HubRoleOwner, "/api/board/owned-mode/working-mode", routes[0].body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = do(false, "", "", "/api/board/local/subscribe", routes[2].body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = do(true, guest, "", "/api/board/owned/subscribe", routes[0].body)
	assert.Equal(t, http.StatusOK, rec.Code, "a guest joining a board that exists is unchanged: %s", rec.Body.String())
}

// The machine can only tell the owner from a guest on a route the owner table stamps (the connector drops the marker everywhere else, and a browser's own is dropped too), so every route that refuses a guest a new
// board must be in the table (#11636): a route left out would refuse the real owner. The stamp itself, and the drop of a forged one, are held per table row through the real connector in pkg/tunnel
// (TestTheRealConnectorStampsEveryOwnerRouteOfTheTableAndNothingElse).
func TestEveryRouteThatRefusesAGuestANewBoardCarriesTheOwnerStamp(t *testing.T) {
	for _, rt := range []struct{ method, path string }{
		{"POST", "/api/board/t/subscribe"},
		{"POST", "/api/board/t/messages"},
		{"POST", "/api/board/t/tasks"},
		{"POST", "/api/board/t/goals"},
		{"PUT", "/api/board/t/working-mode"},
		{"POST", "/api/board/t/working-mode/presets"},
	} {
		assert.True(t, tunnel.IsOwnerRoute(rt.method, rt.path), "%s %s refuses a Hub guest a new board, so the owner table must stamp it", rt.method, rt.path)
	}
}
