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

	"github.com/subgentic/coral/internal/board"
)

// #14478 (from #14460): the row of a file the Operator shared with an agent names the file and carries its id. The route has no {id}, so the route table's row said neither ("Shared a file with | a file").
func TestTheShareRowNamesTheFileAndCarriesItsId(t *testing.T) {
	_, h, _ := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(_ context.Context, sessionID string) (string, string, string) {
		if sessionID == sessAlice {
			return "alpha", "Alice", "worker"
		}
		return "", "", ""
	}
	t.Cleanup(func() { uploaderLookup = old })
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { next.ServeHTTP(w, asPerson(req)) })
	})
	r.Use(ActivityRecorder(h.bs, nil))
	r.Post("/api/board/{project}/operator-artifacts", h.UploadOperatorArtifact)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/board/alpha/operator-artifacts?session_id="+sessAlice, strings.NewReader("the plan, in bytes"))
	require.NoError(t, err)
	req.Header.Set("X-Artifact-Name", "release-plan.md")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	rows := wordRows(t, h.bs)
	require.Len(t, rows, 1)
	assert.Equal(t, board.ActFileShare, rows[0].Action)
	assert.Equal(t, "file", rows[0].ItemKind)
	assert.Regexp(t, `^[0-9a-f]{64}$`, rows[0].ItemID, "the file's id, not empty")
	assert.Equal(t, "release-plan.md", rows[0].Title, "the file's name at the time")
	assert.Equal(t, "alpha", rows[0].Team)
}
