package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #11650: the Operator's pictures for a new goal's description. The route is the Operator's alone, checks the file's own bytes, keeps the picture with the team; the create names only pictures just uploaded for
// that team, an agent cannot attach any, and the goal reads back with them in the order sent.
func TestAGoalCarriesThePicturesTheOperatorAdded(t *testing.T) {
	_, h, coralDir := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) { return "alpha", "Alice", "worker" }
	t.Cleanup(func() { uploaderLookup = old })
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	registerTaskPlanner(t, h, "alpha", "Orchestrator")
	r := chi.NewRouter()
	asPerson := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			fn(w, req)
		}
	}
	r.Post("/api/board/{project}/goal-images", asPerson(h.UploadGoalImage))
	r.Post("/api/board/{project}/goals", asPerson(h.CreateGoal))
	r.Get("/api/board/{project}/goals/{goalID}", h.GetGoal)
	r.Get("/api/board/{project}/goals", h.ListGoals)
	r.Post("/api/board/{project}/goal-images-noperson", h.UploadGoalImage)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	upload := func(path, contentType string, body []byte) (int, map[string]any) {
		req, err := http.NewRequest("POST", srv.URL+path, bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", contentType)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	call := goalCall(t, srv.URL)

	code, out := upload("/api/board/alpha/goal-images", "image/png", shadePNG(t, 10))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	p1 := out["hex"].(string)
	rec, ok := readUploadRecord(coralDir, sessAlice, p1)
	require.True(t, ok, "kept with the team's session")
	assert.Equal(t, sourceGoalImage, rec.Source)
	code, out = upload("/api/board/alpha/goal-images", "image/jpeg", plainJPEG(t))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	p2 := out["hex"].(string)

	// What is not a picture, and a type the bytes do not match, are refused.
	code, out = upload("/api/board/alpha/goal-images", "image/png", []byte("plain text"))
	assert.Equal(t, http.StatusUnsupportedMediaType, code)
	assert.Equal(t, "image_type", out["code"])
	code, out = upload("/api/board/alpha/goal-images", "image/jpeg", shadePNG(t, 11))
	assert.Equal(t, "image_type_mismatch", out["code"])
	// Not the Operator (no person on the request), not a team that exists, a team with no agent.
	code, _ = upload("/api/board/alpha/goal-images-noperson", "image/png", shadePNG(t, 12))
	assert.GreaterOrEqual(t, code, 400, "a route without a person is refused")
	code, _ = upload("/api/board/nowhere/goal-images", "image/png", shadePNG(t, 13))
	assert.Equal(t, http.StatusNotFound, code)
	_, err := h.bs.Subscribe(context.Background(), "empty", "Lead", "Orchestrator", "", nil, "all")
	require.NoError(t, err)
	code, out = upload("/api/board/empty/goal-images", "image/png", shadePNG(t, 14))
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "no_team", out["code"])

	// The create names them; the goal carries them in the order sent, in the create answer, the read and the list.
	code, g := call("POST", "/api/board/alpha/goals", map[string]any{"title": "With pictures", "outcome": "See the pictures", "done_when": "done", "subscriber_id": "Operator", "images": []string{p2, p1}})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	imgs := g["images"].([]any)
	require.Len(t, imgs, 2)
	assert.Equal(t, p2, imgs[0].(map[string]any)["hex"])
	assert.Equal(t, "image/jpeg", imgs[0].(map[string]any)["content_type"])
	id := itoa(int64(g["id"].(float64)))
	code, read := call("GET", "/api/board/alpha/goals/"+id, nil)
	require.Equal(t, 200, code)
	assert.Len(t, read["images"], 2, "the goal reads back with its pictures")
	code, list := call("GET", "/api/board/alpha/goals", nil)
	require.Equal(t, 200, code)
	assert.Equal(t, p2, goalsOf(t, list)[0]["images"].([]any)[0].(map[string]any)["hex"])

	// A picture that was not just added for this team's goal, a repeat, a fifth and an agent's create are refused; a goal with no pictures has no key.
	code, _ = call("POST", "/api/board/alpha/goals", map[string]any{"title": "x", "subscriber_id": "Operator", "images": []string{strings.Repeat("ab", 32)}})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = call("POST", "/api/board/alpha/goals", map[string]any{"title": "x", "subscriber_id": "Operator", "images": []string{p1, p1}})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = call("POST", "/api/board/alpha/goals", map[string]any{"title": "x", "subscriber_id": "Operator", "images": []string{p1, p1, p1, p1, p1}})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = call("POST", "/api/board/alpha/goals", map[string]any{"title": "An agent's", "subscriber_id": "Orchestrator", "images": []string{p1}})
	assert.Equal(t, http.StatusForbidden, code, "an agent attaches no picture")
	code, plain := call("POST", "/api/board/alpha/goals", map[string]any{"title": "No pictures", "subscriber_id": "Operator"})
	require.Equal(t, http.StatusCreated, code, "%v", plain)
	assert.NotContains(t, plain, "images")
	// Another team's picture is not this team's: p1 was added for alpha.
	_, err = h.bs.Subscribe(context.Background(), "beta", "Lead", "Orchestrator", "claude-22222222-aaaa-0000-0000-000000000002", nil, "all")
	require.NoError(t, err)
	code, _ = call("POST", "/api/board/beta/goals", map[string]any{"title": "Borrowed", "subscriber_id": "Operator", "images": []string{p1}})
	assert.Equal(t, http.StatusBadRequest, code, "a picture uploaded for another team")
}

// Through Coral Hub a goal create that names pictures is the owner's alone (Security's INFO on #11650), as the upload is: a guest's create with images is refused, one without images is as before, and the owner's passes.
func TestAGoalWithPicturesThroughTheHubIsTheOwnersAlone(t *testing.T) {
	_, h, _ := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) { return "alpha", "Alice", "worker" }
	oldLabel := hubOwnerLabel
	const owner, guest = "hub-user-0000beef", "hub-user-1234abcd"
	hubOwnerLabel = func(context.Context) (string, error) { return owner, nil }
	t.Cleanup(func() { uploaderLookup = old; hubOwnerLabel = oldLabel })
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	r := chi.NewRouter()
	person := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			if req.Header.Get(tunnel.ViaHeader) == "" {
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			}
			fn(w, req)
		}
	}
	r.Post("/api/board/{project}/goal-images", person(h.UploadGoalImage))
	r.Post("/api/board/{project}/goals", person(h.CreateGoal))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	do := func(path string, body []byte, ct string, hdr map[string]string) (int, map[string]any) {
		req, err := http.NewRequest("POST", srv.URL+path, bytes.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", ct)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	pic := func() string {
		code, out := do("/api/board/alpha/goal-images", shadePNG(t, uint8(len(srv.URL))), "image/png", nil)
		require.Equal(t, http.StatusCreated, code, "%v", out)
		return out["hex"].(string)
	}
	create := func(images []string, hdr map[string]string) int {
		b, _ := json.Marshal(map[string]any{"title": "Through the Hub", "subscriber_id": "Operator", "images": images})
		code, _ := do("/api/board/alpha/goals", b, "application/json", hdr)
		return code
	}
	hubGuestHdr := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: guest}
	hubOwnerHdr := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: owner, tunnel.HubRoleHeader: tunnel.HubRoleOwner}
	p := pic()
	assert.Equal(t, http.StatusForbidden, create([]string{p}, hubGuestHdr), "a Hub guest cannot attach a picture to a goal")
	assert.Equal(t, http.StatusCreated, create(nil, hubGuestHdr), "a goal with no pictures is as before for a guest")
	assert.Equal(t, http.StatusCreated, create([]string{p}, hubOwnerHdr), "the owner through the Hub can")
	assert.Equal(t, http.StatusCreated, create([]string{pic()}, nil), "this computer's person can")
}
