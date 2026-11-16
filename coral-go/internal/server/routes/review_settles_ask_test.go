package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// One decision is one item in Needs you (#17634, walk 78): an agent that sends a plan as a file for review and asks the same question about that file in words made two items; deciding the file now closes
// the open question to the Operator that carries its id, so the pair settles together. A question about another file stays.
func TestDecidingAFileClosesTheQuestionAboutIt(t *testing.T) {
	for _, decision := range []string{"approve", "changes", "deny"} {
		resetOwnerState(t)
		withLabel(t, ownerLabel, nil)
		_, h, coralDir := teamArtifactServer(t)
		r := chi.NewRouter()
		r.Put("/api/board/{project}/artifacts/{id}/tags", h.SetArtifactTags)
		r.Post("/api/board/{project}/artifacts/{id}/review", func(w http.ResponseWriter, req *http.Request) {
			h.ReviewArtifact(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie)))
		})
		s := httptest.NewServer(r)
		t.Cleanup(s.Close)
		subscribeSession(t, h, "alpha", "Alice", sessAlice)
		id := storeManagedArtifact(t, coralDir, "# the plan "+t.Name(), true, true)
		completeWithArtifactsAs(t, h, "alpha", "Alice", "A work", []board.TaskArtifact{{Name: "plan.md", URI: "coral://artifacts/" + id}})
		put, err := http.NewRequest(http.MethodPut, s.URL+"/api/board/alpha/artifacts/"+id+"/tags", strings.NewReader(`{"tags":["for review"]}`))
		require.NoError(t, err)
		put.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(put)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)

		ctx := context.Background()
		ask := func(text string) int64 {
			q, err := h.bs.PostMessage(ctx, "alpha", "Alice", text, nil)
			require.NoError(t, err)
			require.NoError(t, h.bs.RecordAsk(ctx, "alpha", q, []string{"Operator"}))
			return q.ID
		}
		about, other := ask("@Operator Plan coral://artifacts/"+id+" is up. Go ahead with it?"), ask("@Operator Should the logo be blue, as in plan.md?")
		open := func() map[int64]bool {
			asks, err := h.bs.OpenAsksOf(ctx, "alpha", board.OperatorName, time.Now())
			require.NoError(t, err)
			m := map[int64]bool{}
			for _, a := range asks {
				m[a.MessageID] = true
			}
			return m
		}
		require.Equal(t, map[int64]bool{about: true, other: true}, open())

		body := `{"decision":"` + decision + `"}`
		if decision == "changes" {
			body = `{"decision":"changes"}`
		}
		post, err := http.NewRequest(http.MethodPost, s.URL+"/api/board/alpha/artifacts/"+id+"/review", strings.NewReader(body))
		require.NoError(t, err)
		post.Header.Set("Content-Type", "application/json")
		resp, err = http.DefaultClient.Do(post)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, decision)
		assert.Equal(t, map[int64]bool{other: true}, open(), decision+": the question carrying the file id is settled with it; one that only names plan.md stays")
	}
}
