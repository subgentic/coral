package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11005 phase (a): `coral-board search <query>` searches the agent's own board's messages through GET /api/agent/board/search; `read --id` gives the context of a hit.

const searchReply = `{"board":"b-own","reach":"own","total":3,"limit":2,"next_cursor":"CUR2","messages":[
 {"id":41,"subscriber_id":"Lead","job_title":"Orchestrator","content":"We decided the release train leaves on Thursday\nand nobody ships on Friday.","created_at":"2026-10-20T10:00:00Z"},
 {"id":57,"subscriber_id":"Dev","job_title":"Developer","content":"Moving the release train: see task #12","created_at":"2026-10-22T09:30:00Z"}]}`

func searchServer(t *testing.T) *goalServer {
	gs := newGoalServer(t)
	gs.setReply("GET /api/agent/board/search", searchReply)
	return gs
}

func TestBoardSearchSendsTheQueryAndPrintsHitsWithTheirIds(t *testing.T) {
	gs := searchServer(t)
	res := goalRun(t, gs, "search", "release train", "--from", "Lead", "--since", "2026-10-01T00:00:00Z", "--limit", "2", "--sort", "oldest")
	require.Equal(t, 0, res.code, res.stderr)
	reqs := gs.requests()
	require.Len(t, reqs, 1)
	for _, want := range []string{"GET /api/agent/board/search?", "q=release+train", "from=Lead", "since=2026-10-01T00%3A00%3A00Z", "limit=2", "sort=oldest"} {
		assert.Contains(t, reqs[0], want)
	}
	assert.NotContains(t, reqs[0], "reach=", "no flag: the server's default, own")
	for _, want := range []string{"#41", "#57", "Lead", "Orchestrator", "Thursday", "2026-10-20", "3 matches", "--cursor CUR2", "coral-board read --id"} {
		assert.Contains(t, res.stdout, want)
	}
	assert.NotContains(t, res.stdout, "\n  nobody", "a hit is one line: its newlines are joined")
}

func TestBoardSearchReachFlagsAreSentAndARefusalIsRelayedAsIs(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	refusal := `{"error":"Refused: this agent's search access is 'own', its own board. Searching beyond it (--team) is not available yet.","code":"search_reach_refused","level":"own","requested":"team"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path+"?"+r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(refusal))
	}))
	t.Cleanup(srv.Close)
	dir := subscribedDataDir(t, srv.URL)
	for flag, reach := range map[string]string{"--team": "team", "--all": "all", "--operator-history": "operator"} {
		res := runBoard(t, srv.URL, dir, "search", "canary", flag)
		assert.Equal(t, 5, res.code, "%s: the refused exit code: %s", flag, res.stderr)
		assert.Contains(t, res.stderr, "Refused: this agent's search access is 'own'", "the server's line, unchanged, for the agent to relay")
		assert.Empty(t, res.stdout)
		mu.Lock()
		last := seen[len(seen)-1]
		mu.Unlock()
		assert.Contains(t, last, "/api/agent/board/search?")
		assert.Contains(t, last, "reach="+reach, flag)
	}
	res := runBoard(t, srv.URL, dir, "search", "canary", "--team", "--all")
	assert.NotEqual(t, 0, res.code, "two reaches at once")
}

func TestBoardSearchJSONIsTheServersAnswer(t *testing.T) {
	gs := searchServer(t)
	res := goalRun(t, gs, "search", "release", "--json")
	require.Equal(t, 0, res.code, res.stderr)
	var out map[string]any
	require.NoError(t, json.Unmarshal([]byte(res.stdout), &out), res.stdout)
	assert.Equal(t, "b-own", out["board"])
	assert.Len(t, out["messages"], 2)
	assert.Equal(t, "CUR2", out["next_cursor"])
}

func TestBoardSearchSaysWhenNothingMatchesAndRefusesBadUsage(t *testing.T) {
	gs := searchServer(t)
	gs.setReply("GET /api/agent/board/search", `{"board":"b-own","reach":"own","total":0,"limit":20,"messages":[]}`)
	res := goalRun(t, gs, "search", "nothing here")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "No messages match")
	before := len(gs.requests())
	for _, args := range [][]string{{"search"}, {"search", "a", "b"}, {"search", "--bogus", "x"}, {"search", ""}} {
		res = goalRun(t, gs, args...)
		assert.NotEqual(t, 0, res.code, "%v", args)
	}
	assert.Equal(t, before, len(gs.requests()), "bad usage sends nothing")
}

func TestBoardSearchPrintsOtherPeoplesWordsWithoutControlCharacters(t *testing.T) {
	gs := searchServer(t)
	gs.setReply("GET /api/agent/board/search", `{"board":"b","reach":"own","total":1,"limit":20,"messages":[{"id":9,"subscriber_id":"X","job_title":"Y","content":"canary \u001b[2J\u001b]0;pwned\u0007 text","created_at":"2026-10-20T10:00:00Z"}]}`)
	res := goalRun(t, gs, "search", "canary")
	require.Equal(t, 0, res.code, res.stderr)
	assert.NotContains(t, res.stdout, "\x1b")
	assert.NotContains(t, res.stdout, "\x07")
	assert.Contains(t, res.stdout, "canary")
}
