package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// #19901: the Operator's typed answer to an agent's question wakes the asker if it was put to sleep after it asked (a post that only tags it never wakes a manual sleeper, so the answer sat unread).
func TestTheOperatorsAnswerToAnAskWakesTheAskerAndNothingElseDoes(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	sid := "5e7d0000-1111-4222-8333-000000000077"
	_, err := h.bs.Subscribe(ctx, "team", "Video Producer", "Video Producer", naming.SessionName("claude", sid), nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Dev", "Developer", "", nil, "all")
	require.NoError(t, err)
	var mu sync.Mutex
	var woken []string
	h.SetOperatorWaker(func(_ context.Context, s string) bool {
		mu.Lock()
		defer mu.Unlock()
		woken = append(woken, s)
		return true
	})
	wokenNow := func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), woken...) }

	ask, err := h.bs.PostMessage(ctx, "team", "Video Producer", "Which cut do you want? @Operator", nil)
	require.NoError(t, err)
	require.NoError(t, h.bs.RecordAsk(ctx, "team", ask, []string{"Operator"}))
	plain, err := h.bs.PostMessage(ctx, "team", "Video Producer", "An update", nil)
	require.NoError(t, err)

	post := func(who string, replyTo int64) {
		body := `{"subscriber_id":"` + who + `","content":"the shorter one"`
		if replyTo != 0 {
			body += `,"reply_to":` + itoa(replyTo)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/messages", strings.NewReader(body+`}`))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(context.WithValue(req.Context(), chi.RouteCtxKey, rctx), callerKindKey{}, callerDashCookie)) // the Operator at the dashboard
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Less(t, rec.Code, 300, rec.Body.String())
	}
	post("Operator", plain.ID) // the Operator's reply to a message that is no question: nobody is woken
	post("Operator", 0)        // a plain post of the Operator's: nobody is woken (a mention never wakes a manual sleeper)
	time.Sleep(200 * time.Millisecond)
	assert.Empty(t, wokenNow())
	post("Operator", ask.ID)
	require.Eventually(t, func() bool { return len(wokenNow()) == 1 }, 3*time.Second, 20*time.Millisecond, "the Operator's answer woke the asker")
	assert.Equal(t, []string{sid}, wokenNow())
}
