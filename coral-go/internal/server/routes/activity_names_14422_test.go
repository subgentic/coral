package routes

import (
	"context"
	"encoding/json"
	"fmt"
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
)

// #14422 (Threading S2): the Activity row carries the name of the item at the time of the action: a file's name for star, unstar, keep and release, and for an ask its own line with the asker beside it.

// A button answer: the title is the ask's line, the asker is who asked, the note is the button's label.
func TestAButtonAnswerRowCarriesTheAsksLineAndTheAsker(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Ship it=reply", "Hold=reply")
	code, out := c.call(true, ask, ids[0], "claim", `{}`)
	require.Equal(t, http.StatusOK, code, out)
	rows, err := c.bs.ListActivity(context.Background(), board.ActivityFilter{Action: board.ActAnswer, Limit: 5})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "@Operator Ship the release?", rows[0].Title, "the ask's own line, not empty")
	assert.Equal(t, "Lead", rows[0].Asker)
	assert.Equal(t, itoa(ask), rows[0].ItemID, "the ask it answers")
	assert.Equal(t, "Ship it", rows[0].Note)
}

// Ignore and its Undo: both rows say which ask.
func TestAnIgnoreAndItsUndoCarryTheAsksLineAndTheAsker(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Head of Security", "Head of Security", "", nil, "all")
	require.NoError(t, err)
	q, err := bs.PostMessage(ctx, "team", "Head of Security", "@Operator Ship batch-120 tonight?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	call := func(body map[string]any) int {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/board/team/asks/%d/close", q.ID), strings.NewReader(string(raw)))
		req = asPerson(withActor(req, Actor{Kind: ActorOperator, Name: "Operator"}))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("project", "team")
		rc.URLParams.Add("messageID", fmt.Sprint(q.ID))
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		w := httptest.NewRecorder()
		h.CloseAsk(w, req)
		return w.Code
	}
	require.Equal(t, http.StatusOK, call(map[string]any{"note": "Dismissed by the operator"}))
	require.Equal(t, http.StatusOK, call(map[string]any{"undo": true}))
	rows, err := bs.ListActivity(ctx, board.ActivityFilter{Limit: 10}) // newest first
	require.NoError(t, err)
	require.Len(t, rows, 2)
	for _, r := range rows {
		assert.Equal(t, "@Operator Ship batch-120 tonight?", r.Title, r.Action)
		assert.Equal(t, "Head of Security", r.Asker, r.Action)
		assert.Equal(t, itoa(q.ID), r.ItemID, r.Action)
	}
	assert.Equal(t, board.ActUnignore, rows[0].Action)
	assert.Equal(t, board.ActIgnore, rows[1].Action)
}

// A click on a file names the file: the recorder looks the name up in the object's sidecar at the click. A file with no sidecar is the empty title it always was.
func TestAFileClickRowCarriesTheFilesName(t *testing.T) {
	_, _, coralDir := teamArtifactServer(t)
	id := storeManagedArtifact(t, coralDir, "# the report", true, true)
	want := StoredFileName(coralDir, id)
	require.NotEmpty(t, want, "the stored file has a name in its sidecar")
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { next.ServeHTTP(w, asPerson(req)) })
	})
	r.Use(ActivityRecorder(bs, func(file string) string { return StoredFileName(coralDir, file) }))
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	r.Put("/api/artifacts/{id}/star", ok)
	r.Delete("/api/artifacts/{id}/star", ok)
	r.Put("/api/artifacts/{id}/keep", ok)
	r.Delete("/api/artifacts/{id}/keep", ok)
	for _, c := range []struct{ method, path string }{{"PUT", "star"}, {"DELETE", "star"}, {"PUT", "keep"}, {"DELETE", "keep"}} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(c.method, "/api/artifacts/"+id+"/"+c.path, nil))
	}
	other := strings.Repeat("e", 64) // no sidecar
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("PUT", "/api/artifacts/"+other+"/star", nil))
	rows := wordRows(t, bs) // newest first
	require.Len(t, rows, 5)
	assert.Empty(t, rows[0].Title, "a file the store has no name for stays as before")
	for _, row := range rows[1:] {
		assert.Equal(t, want, row.Title, row.Action)
		assert.Equal(t, id, row.ItemID, row.Action)
	}
}
