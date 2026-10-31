package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11596: GET /api/needs-you is what waits for the Operator in one read, for the Hub's phone push: waiting agents (the sessions handler's rows, here a seam), questions and waits, proposals, and unread files for
// review, each as one cleaned and cut line with its team, a stable id and a time, a count that matches the Inbox's for those four, and a cursor so a poller gets only what is newer.

func readNeedsYou(t *testing.T, h *BoardHandler, query string, mod func(*http.Request) *http.Request) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/needs-you"+query, nil)
	if mod != nil {
		req = mod(req)
	}
	w := httptest.NewRecorder()
	h.NeedsYou(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func needsYouItems(out map[string]any) []map[string]any {
	var items []map[string]any
	for _, v := range out["items"].([]any) {
		items = append(items, v.(map[string]any))
	}
	return items
}

func TestNeedsYouCountsEverySourceAndCleansAndCutsTheLines(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) {
		return []NeedsYouItem{{Kind: "agent", From: "Dev", Line: "Wants to run a command", Team: "team", ID: "agent:s1", At: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)}}, nil
	})
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I ‮proceed?\n"+strings.Repeat("long ", 100), nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	_, err = bs.RegisterWait(ctx, "team", "Dev", "claude-x", board.WaitOperator, "", "may I delete the old table?", time.Hour)
	require.NoError(t, err)
	_, _, err = bs.CreateProposal(ctx, board.ProposalInput{Board: "team", Kind: board.ProposalTask, Title: "Add the export", Payload: json.RawMessage(`{"title":"Add the export"}`), Proposer: "Lead"})
	require.NoError(t, err)

	code, out := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code, out)
	assert.EqualValues(t, 4, out["count"])
	counts := out["counts"].(map[string]any)
	assert.EqualValues(t, 1, counts["agent"])
	assert.EqualValues(t, 1, counts["question"])
	assert.EqualValues(t, 1, counts["wait"])
	assert.EqualValues(t, 1, counts["proposal"])
	assert.EqualValues(t, 0, counts["review"])
	assert.Equal(t, []any{"failed_runs", "welcome", "unrecorded_agents"}, out["not_included"], "what the Inbox counts and this read cannot see is named")
	byKind := map[string]map[string]any{}
	for _, it := range needsYouItems(out) {
		byKind[it["kind"].(string)] = it
		assert.Equal(t, "team", it["team"])
		assert.NotEmpty(t, it["id"])
		assert.NotEmpty(t, it["at"])
	}
	line := byKind["question"]["line"].(string)
	assert.NotContains(t, line, "‮", "a hidden character is out")
	assert.NotContains(t, line, "\n", "one line")
	assert.LessOrEqual(t, len([]rune(line)), needsYouLineMax, "cut")
	assert.Equal(t, "Lead", byKind["question"]["from"])
	assert.Equal(t, "Add the export", byKind["proposal"]["line"])
	assert.Equal(t, "may I delete the old table?", byKind["wait"]["line"])
}

func TestNeedsYouCursorGivesWhatIsAtOrAfterItSoTiesAreNeverLost(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	ask := func(text string) {
		q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator "+text, nil)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	}
	ask("first?")
	_, out := readNeedsYou(t, h, "", asPerson)
	cursor, _ := out["cursor"].(string)
	require.NotEmpty(t, cursor)
	_, out = readNeedsYou(t, h, "?after="+cursor, asPerson)
	require.Len(t, needsYouItems(out), 1, "the newest item is at the cursor: it comes again, and its id lets a poller skip it")
	ids := map[string]bool{needsYouItems(out)[0]["id"].(string): true}
	ask("second?")
	_, out = readNeedsYou(t, h, "?after="+cursor, asPerson)
	require.Len(t, needsYouItems(out), 2, "a second item in the same instant is not lost")
	fresh := 0
	for _, it := range needsYouItems(out) {
		if !ids[it["id"].(string)] {
			fresh++
		}
	}
	assert.Equal(t, 1, fresh)
	code, _ := readNeedsYou(t, h, "?after=yesterday", asPerson)
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = readNeedsYou(t, h, "?limit=0", asPerson)
	assert.Equal(t, http.StatusBadRequest, code)
	_, out = readNeedsYou(t, h, "?after=2999-01-01T00:00:00Z", asPerson)
	assert.Empty(t, needsYouItems(out), "a cursor from the future gives nothing")
	assert.EqualValues(t, 2, out["count"])
}

func TestNeedsYouSaysWhenASourceCouldNotBeRead(t *testing.T) {
	h, _ := operatorAsksRig(t)
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) { return nil, errors.New("terminal gone") })
	code, out := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []any{"agents"}, out["unread_sources"], "missing from the count, not zero")
}

func TestNeedsYouIsTheOperatorsAlone(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	code, out := readNeedsYou(t, h, "", nil)
	assert.Equal(t, http.StatusForbidden, code, "not a person: an agent, a script")
	assert.NotContains(t, out, "items")
	code, _ = readNeedsYou(t, h, "", func(r *http.Request) *http.Request {
		r.Header.Set("X-Coral-Via-Tunnel", "1")
		return asPerson(r)
	})
	assert.Equal(t, http.StatusForbidden, code, "through the Hub, only the owner")
}

func TestNeedsYouCountsOnlyUnreadFilesForReview(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	count := func() (int, map[string]any) {
		req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
		w := httptest.NewRecorder()
		e.h.NeedsYou(w, req)
		var out map[string]any
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return int(out["count"].(float64)), out
	}
	n, out := count()
	require.Equal(t, 1, n)
	it := needsYouItems(out)[0]
	assert.Equal(t, "review", it["kind"])
	assert.Equal(t, "plan.md", it["line"])
	e.tag(t, `["for review", "read"]`)
	n, _ = count()
	assert.Equal(t, 0, n, "a file the Operator opened is listed in Needs you but not counted")
	e.tag(t, `["for review"]`)
	code, _ := e.decide(t, `{"decision":"ignore"}`)
	require.Equal(t, http.StatusOK, code)
	n, _ = count()
	assert.Equal(t, 0, n, "an ignored file is not waiting")
	code, _ = e.decide(t, `{"decision":"unignore"}`)
	require.Equal(t, http.StatusOK, code)
	n, _ = count()
	assert.Equal(t, 1, n, "unignored: waiting again")
	code, _ = e.decide(t, `{"decision":"deny"}`)
	require.Equal(t, http.StatusOK, code)
	n, _ = count()
	assert.Equal(t, 0, n, "a denied file is not waiting")
}
