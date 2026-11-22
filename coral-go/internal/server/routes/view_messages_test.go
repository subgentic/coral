package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// A View person is answered by a fixed list of fields: nothing else of the stored row is shown, whatever the row holds.
func TestAViewMessageShowsOnlyTheAllowlistedFields(t *testing.T) {
	origin, hubUser, task := "hub_user", "hub-user-aaaa1111", int64(7)
	out, ok := viewMessages([]board.Message{{ID: 5, Project: "team1", SubscriberID: "sub-secret-id", Content: "hello", CreatedAt: "2026-11-22T06:00:00Z", JobTitle: "Backend Dev",
		Origin: &origin, HubUser: &hubUser, TaskID: &task, External: board.RawJSON(`{"from":"other team"}`), IsSystem: true}})
	require.True(t, ok)
	raw, err := json.Marshal(out)
	require.NoError(t, err)
	var rows []map[string]any
	require.NoError(t, json.Unmarshal(raw, &rows))
	require.Len(t, rows, 1)
	keys := []string{}
	for k := range rows[0] {
		keys = append(keys, k)
	}
	assert.ElementsMatch(t, []string{"id", "content", "created_at", "job_title", "is_system"}, keys, "the field allowlist, exactly")
	assert.NotContains(t, string(raw), "sub-secret-id")
	assert.NotContains(t, string(raw), "hub-user-aaaa1111")
	assert.NotContains(t, string(raw), "other team")
}

func TestAViewMessageIsRedactedCutAndTheAnswerCapped(t *testing.T) {
	secret := "sk-ant-api03-" + strings.Repeat("A1b2C3d4", 8)
	out, ok := viewMessages([]board.Message{{ID: 1, Content: "key " + secret + " end"}})
	require.True(t, ok)
	assert.NotContains(t, out[0].Content, secret, "the secret is redacted before anything is shown")

	long, ok := viewMessages([]board.Message{{ID: 2, Content: strings.Repeat("x", viewMessageTextMax+500)}})
	require.True(t, ok)
	assert.LessOrEqual(t, len([]rune(long[0].Content)), viewMessageTextMax+1, "one message's text is cut")

	many := make([]board.Message, viewMessageMax+40)
	for i := range many {
		many[i] = board.Message{ID: int64(i + 1), Content: "m"}
	}
	capped, ok := viewMessages(many)
	require.True(t, ok)
	assert.Len(t, capped, viewMessageMax, "the number of messages is capped")

	big := make([]board.Message, 90)
	for i := range big {
		big[i] = board.Message{ID: int64(i + 1), Content: strings.Repeat("y", viewMessageTextMax)}
	}
	sized, ok := viewMessages(big)
	require.True(t, ok)
	assert.Less(t, len(sized), 90, "the answer stops at its size cap")

	redactCommentFailsFor = func(text string) bool { return strings.Contains(text, "unredactable") }
	t.Cleanup(func() { redactCommentFailsFor = nil })
	_, ok = viewMessages([]board.Message{{ID: 3, Content: "unredactable"}})
	assert.False(t, ok, "a redactor that cannot run shows nothing")
}

// Through the route: a request marked View-only gets the typed answer, a tunneled one that is not marked keeps the stored row's fields.
func TestTheMessagesRouteAnswersAViewOnlyPersonWithTheTypedShape(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team1", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.PostMessage(ctx, "team1", "Lead", "status: done", nil)
	require.NoError(t, err)
	mark := func(viewOnly bool) http.Handler {
		r := chi.NewRouter()
		r.Get("/api/board/{project}/messages", h.ReadMessages)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
			if viewOnly {
				req = req.WithContext(cloud.WithViewOnly(req.Context()))
			}
			r.ServeHTTP(w, req)
		})
	}
	get := func(viewOnly bool) map[string]any {
		rec := httptest.NewRecorder()
		mark(viewOnly).ServeHTTP(rec, httptest.NewRequest("GET", "/api/board/team1/messages", nil))
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var rows []map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
		require.NotEmpty(t, rows)
		return rows[0]
	}
	typed := get(true)
	assert.NotContains(t, typed, "subscriber_id", "the View answer has no sender id")
	assert.NotContains(t, typed, "project")
	assert.Equal(t, "status: done", typed["content"])
	assert.Contains(t, get(false), "subscriber_id", "an unmarked tunneled read is as before")
}
