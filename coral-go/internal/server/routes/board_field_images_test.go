package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20731 (goal #285): the Operator's pictures for the prose fields of a task, the board chat and instructions. Team routes keep the picture with the team (or the person's own when it has no agent), the person route
// has no team and takes only instructions; both are the person's alone, check the file's own bytes, and remember the upload under its scope and draft for the writes that will name it.
func TestAPersonUploadsAPictureForAFieldOfATeamOrOfNoTeam(t *testing.T) {
	_, h, coralDir := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) { return "alpha", "Alice", "worker" }
	t.Cleanup(func() { uploaderLookup = old })
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	r := chi.NewRouter()
	asPerson := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			fn(w, req)
		}
	}
	r.Post("/api/board/{project}/field-images", asPerson(h.UploadFieldImage))
	r.Post("/api/field-images", asPerson(h.UploadPersonFieldImage))
	r.Post("/noperson/board/{project}/field-images", h.UploadFieldImage)
	r.Post("/noperson/field-images", h.UploadPersonFieldImage)
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

	// Each team field takes a picture, kept with the team's session, named by hash and uri, with its scope and draft, remembered under that scope and draft only.
	for i, scope := range []string{"task", "chat", "instruction"} {
		code, out := upload("/api/board/alpha/field-images?scope="+scope+"&draft=d-"+scope, "image/png", shadePNG(t, uint8(20+i)))
		require.Equal(t, http.StatusCreated, code, "%s: %v", scope, out)
		hex := out["hex"].(string)
		assert.Equal(t, "coral://artifacts/"+hex, out["uri"])
		assert.Equal(t, "field-image:"+scope, out["source"])
		assert.Equal(t, scope, out["scope"])
		assert.Equal(t, "d-"+scope, out["draft"])
		rec, ok := readUploadRecord(coralDir, sessAlice, hex)
		require.True(t, ok, scope+": kept with the team's session")
		assert.Equal(t, "field-image:"+scope, rec.Source)
		assert.Equal(t, "owner", rec.UploadedBy)
		assert.True(t, recentCommentImage(fieldImageScope("alpha", scope, "d-"+scope), hex, time.Now()), scope+": remembered for its draft")
		assert.False(t, recentCommentImage(fieldImageScope("alpha", scope, "other"), hex, time.Now()), scope+": not for another draft")
		assert.False(t, recentCommentImage(goalImageScope("alpha"), hex, time.Now()), scope+": not a goal's picture")
	}

	// No draft is allowed; the person route has no team and takes only instructions, kept as the person's own.
	code, out := upload("/api/board/alpha/field-images?scope=task", "image/jpeg", plainJPEG(t))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, "", out["draft"])
	code, out = upload("/api/field-images?scope=instruction", "image/png", shadePNG(t, 30))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	rec, ok := readUploadRecord(coralDir, personPictureSession, out["hex"].(string))
	require.True(t, ok, "kept as the person's own")
	assert.Equal(t, "field-image:instruction", rec.Source)
	code, _ = upload("/api/field-images?scope=task", "image/png", shadePNG(t, 31))
	assert.Equal(t, http.StatusBadRequest, code, "a task belongs to a team")

	// Refusals: a scope that is not one, a bad draft, a file that is not a picture or whose type its bytes contradict, a team that does not exist, no person on the request.
	code, _ = upload("/api/board/alpha/field-images?scope=goal", "image/png", shadePNG(t, 32))
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = upload("/api/board/alpha/field-images", "image/png", shadePNG(t, 33))
	assert.Equal(t, http.StatusBadRequest, code, "scope is required")
	code, _ = upload("/api/board/alpha/field-images?scope=task&draft=../x", "image/png", shadePNG(t, 34))
	assert.Equal(t, http.StatusBadRequest, code)
	code, out = upload("/api/board/alpha/field-images?scope=task", "image/png", []byte("plain text"))
	assert.Equal(t, http.StatusUnsupportedMediaType, code)
	assert.Equal(t, "image_type", out["code"])
	code, out = upload("/api/board/alpha/field-images?scope=task", "image/jpeg", shadePNG(t, 35))
	assert.Equal(t, "image_type_mismatch", out["code"])
	code, _ = upload("/api/board/nowhere/field-images?scope=task", "image/png", shadePNG(t, 36))
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = upload("/noperson/board/alpha/field-images?scope=task", "image/png", shadePNG(t, 37))
	assert.GreaterOrEqual(t, code, 400, "no person: refused")
	code, _ = upload("/noperson/field-images?scope=instruction", "image/png", shadePNG(t, 38))
	assert.GreaterOrEqual(t, code, 400, "no person: refused")
}
