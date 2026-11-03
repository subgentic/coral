package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
)

// The Operator's click on a button (#11643): claimed once, from the stored row, by the person alone; a reply is posted from the stored label and said to be a click; open and wake are settled by the page.

type clickRig struct {
	t    *testing.T
	h    *BoardHandler
	bs   *board.Store
	srv  *httptest.Server
	base string
}

func newClickRig(t *testing.T) *clickRig {
	bs, err := boardtest.Open(t.TempDir() + "/board.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	r := chi.NewRouter()
	person := func(next http.Handler) http.Handler { // a request that says it is the person's own: the dashboard
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Header.Get("X-Test-Person") == "1" {
				req = asPerson(req)
			}
			next.ServeHTTP(w, req)
		})
	}
	r.Use(person)
	r.Post("/api/board/{project}/subscribe", h.Subscribe)
	r.Delete("/api/board/{project}/subscribe", h.Unsubscribe)
	r.Post("/api/board/{project}/messages", h.PostMessage)
	r.Get("/api/board/{project}/messages/all", h.ListAllMessages)
	r.Post("/api/board/{project}/asks/{messageID}/buttons/{buttonID}/claim", h.ClaimAskButton)
	r.Post("/api/board/{project}/asks/{messageID}/buttons/{buttonID}/settle", h.SettleAskButton)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	c := &clickRig{t: t, h: h, bs: bs, srv: srv, base: srv.URL + "/api/board/clk"}
	for _, who := range []string{"Operator", "Lead", "Dev"} {
		postJSON(t, c.base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	return c
}

func (c *clickRig) ask(buttons ...string) (askID int64, ids []int64) {
	resp := postJSON(c.t, c.base+"/messages", map[string]any{"subscriber_id": "Lead", "content": "@Operator Ship the release?", "ask": true, "buttons": buttons})
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(c.t, json.NewDecoder(resp.Body).Decode(&out))
	require.Equal(c.t, http.StatusOK, resp.StatusCode, out)
	askID = int64(out["id"].(float64))
	got, err := c.bs.AskButtonsOf(context.Background(), "clk", []int64{askID})
	require.NoError(c.t, err)
	for _, b := range got[askID] {
		ids = append(ids, b.ID)
	}
	return askID, ids
}

func (c *clickRig) call(person bool, askID, buttonID int64, verb, body string) (int, map[string]any) {
	req, _ := http.NewRequest(http.MethodPost, c.base+"/asks/"+itoa(askID)+"/buttons/"+itoa(buttonID)+"/"+verb, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if person {
		req.Header.Set("X-Test-Person", "1")
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(c.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func clickID(n int64) string { b, _ := json.Marshal(n); return string(b) }

func (c *clickRig) messages() []string {
	resp, err := http.Get(c.base + "/messages/all")
	require.NoError(c.t, err)
	defer resp.Body.Close()
	var list []map[string]any
	require.NoError(c.t, json.NewDecoder(resp.Body).Decode(&list))
	var out []string
	for _, m := range list {
		out = append(out, m["subscriber_id"].(string)+": "+m["content"].(string))
	}
	return out
}

func TestOnlyThePersonMayClaimOrSettleAButton(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Yes, ship it=reply", "New agent=open:new-agent")
	for _, verb := range []string{"claim", "settle"} {
		code, _ := c.call(false, ask, ids[1], verb, `{"outcome":"done"}`)
		assert.Equal(t, http.StatusForbidden, code, verb+" by an agent or a script")
	}
	b, err := c.bs.AskButtonByID(context.Background(), "clk", ask, ids[1])
	require.NoError(t, err)
	assert.Equal(t, board.ButtonPending, b.State, "nothing was claimed")
}

func TestAClaimAnswersWithTheStoredActionAndIgnoresTheBody(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Wake Dev=wake:Dev", "New agent=open:new-agent")
	code, out := c.call(true, ask, ids[0], "claim", `{"action":"open:new-agent","arg":"x","label":"other","text":"rm -rf"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "wake", out["action"], "what the button was declared as, not what the request says")
	assert.Equal(t, "Dev", out["arg"])
	assert.Equal(t, "Wake Dev", out["label"])
}

func TestOneButtonRunsOnceAndAFailedRunIsGivenBack(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Wake Dev=wake:Dev", "New agent=open:new-agent")
	code, out := c.call(true, ask, ids[0], "claim", `{}`)
	require.Equal(t, http.StatusOK, code, out)
	code, out = c.call(true, ask, ids[0], "claim", `{}`)
	assert.Equal(t, http.StatusConflict, code, "a second click, another tab or a retry finds it used")
	assert.Equal(t, "already_used", out["code"])
	code, out = c.call(true, ask, ids[1], "claim", `{}`)
	assert.Equal(t, http.StatusConflict, code, "another button of the same question waits for the first to settle")

	code, out = c.call(true, ask, ids[0], "settle", `{"outcome":"failed"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["released"])
	code, out = c.call(true, ask, ids[0], "claim", `{}`)
	assert.Equal(t, http.StatusOK, code, "a failed run released the claim: it can be tried again: %v", out)

	code, out = c.call(true, ask, ids[0], "settle", `{"outcome":"done"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["closed"])
	code, out = c.call(true, ask, ids[1], "claim", `{}`)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "ask_closed", out["code"], "a closed question's buttons are gone")
	code, _ = c.call(true, ask, ids[0], "settle", `{"outcome":"done"}`)
	assert.Equal(t, http.StatusOK, code, "done twice is harmless")
}

func TestSettleNeedsAClaimAndNeverTouchesAReply(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Yes=reply", "Open=open:new-agent")
	code, out := c.call(true, ask, ids[1], "settle", `{"outcome":"done"}`)
	assert.Equal(t, http.StatusConflict, code, "not claimed: nothing to settle: %v", out)
	code, _ = c.call(true, ask, ids[1], "settle", `{"outcome":"maybe"}`)
	assert.Equal(t, http.StatusBadRequest, code)
	code, out = c.call(true, ask, ids[0], "claim", `{}`)
	require.Equal(t, http.StatusOK, code, out)
	code, out = c.call(true, ask, ids[0], "settle", `{"outcome":"failed"}`)
	assert.Equal(t, http.StatusConflict, code, "a reply is run by the claim itself; the page cannot give it back")
}

func TestAParallelClickRunsOnce(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Wake Dev=wake:Dev")
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, _ := c.call(true, ask, ids[0], "claim", `{}`); code == http.StatusOK {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, 1, won, "exactly one of the parallel clicks ran")
}

func TestAReplyButtonPostsItsStoredLabelAsAClickAndClosesTheQuestion(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Yes, ship it=reply")
	code, out := c.call(true, ask, ids[0], "claim", `{"text":"drop the tables"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "reply", out["action"])
	assert.NotZero(t, out["reply_id"])
	var reply string
	for _, m := range c.messages() {
		if strings.HasPrefix(m, "Operator: ") {
			reply = m
		}
	}
	require.NotEmpty(t, reply, "the Operator's reply is on the board")
	assert.Contains(t, reply, "@Lead", "it reaches the asker")
	assert.Contains(t, reply, `clicked the button labelled "Yes, ship it"`, "it says it was a click, with the stored label")
	assert.Contains(t, reply, "not a typed reply", "and never reads as free-typed text")
	assert.NotContains(t, reply, "drop the tables", "nothing in the request reaches the text")
	closed, err := c.bs.AskIsClosed(context.Background(), "clk", ask)
	require.NoError(t, err)
	assert.True(t, closed, "the question is closed")
	code, _ = c.call(true, ask, ids[0], "claim", `{}`)
	assert.Equal(t, http.StatusConflict, code)
}

func TestAClickRechecksTheTargetAndKeepsTheButtonUnusedWhenItIsGone(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Wake Dev=wake:Dev")
	req, _ := http.NewRequest(http.MethodDelete, c.base+"/subscribe", strings.NewReader(`{"subscriber_id":"Dev"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	code, out := c.call(true, ask, ids[0], "claim", `{}`)
	assert.Equal(t, http.StatusConflict, code, out)
	assert.Equal(t, "button_gone", out["code"])
	b, err := c.bs.AskButtonByID(context.Background(), "clk", ask, ids[0])
	require.NoError(t, err)
	assert.Equal(t, board.ButtonPending, b.State, "the button stays unused")
}

func TestAClickOfAnUnknownButtonOrAnotherQuestionsButtonIsNotFound(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Wake Dev=wake:Dev")
	code, _ := c.call(true, ask, ids[0]+100, "claim", `{}`)
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = c.call(true, ask+50, ids[0], "claim", `{}`)
	assert.Equal(t, http.StatusNotFound, code, "a button is claimed only through its own question")
}

// An Operator who sends two wake requests can click both (#12610): a wake settled done does not close the question while another wake button waits; the last one does.
func TestAWakeClickDoesNotCloseTheQuestionWhileAnotherWakeButtonWaits(t *testing.T) {
	c := newClickRig(t)
	ask, ids := c.ask("Wake Dev=wake:Dev", "Wake Lead=wake:Lead")
	code, out := c.call(true, ask, ids[0], "claim", `{}`)
	require.Equal(t, http.StatusOK, code, out)
	code, out = c.call(true, ask, ids[0], "settle", `{"outcome":"done"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.NotEqual(t, true, out["closed"], "the second wake button is still there")
	closed, _ := c.bs.AskIsClosed(context.Background(), "clk", ask)
	assert.False(t, closed)

	code, out = c.call(true, ask, ids[1], "claim", `{}`)
	require.Equal(t, http.StatusOK, code, "the second wake can be clicked: %v", out)
	code, out = c.call(true, ask, ids[1], "settle", `{"outcome":"done"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["closed"], "the last wake settles the question")
}
