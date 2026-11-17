package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// coral-search slice 2 (#19236, goal #244): a word that only a past chat holds is found from the agent's own token through the one search: by --source history and in the default mix, with --author, --since/--until
// and --agent narrowing it, in the one result shape. A hit names the session and the turn (for coral-agent history context).
func TestAgentBoardSearchFindsPastChatsWithFilters(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-a", "Operator")
	require.NoError(t, err)

	dir := t.TempDir()
	old := "eeeeeeee-1105-4000-8000-0000000019b0"
	file := filepath.Join(dir, old+".jsonl")
	require.NoError(t, os.WriteFile(file, []byte(
		`{"type":"user","timestamp":"2026-10-01T08:00:00Z","message":{"content":"please remember the quokka plan"}}`+"\n"+
			`{"type":"assistant","timestamp":"2026-10-01T08:00:05Z","message":{"content":"noted: the quokka plan is in the doc"}}`+"\n"+
			`{"type":"assistant","timestamp":"2026-11-01T08:00:05Z","message":{"content":"later the quokka plan changed"}}`+"\n"), 0o644))
	first, last := "2026-10-01T08:00:00Z", "2026-11-01T08:00:05Z"
	require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: old, SourceType: "claude", SourceFile: file, FirstTimestamp: &first, LastTimestamp: &last, MessageCount: 3}))

	sid := "eeeeeeee-1105-4000-8000-0000000019b1"
	boardKey := a.ID
	resume := old
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: dir, BoardName: &boardKey, ResumeFromID: &resume}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dev-aaaa", "Dev", "claude-"+sid, nil, "all")
	require.NoError(t, err)

	search := func(params url.Values) (int, []map[string]any, string) {
		req, _ := http.NewRequest("GET", ts.URL+"/api/agent/board/search?"+params.Encode(), nil)
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out struct {
			Results []map[string]any `json:"results"`
		}
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out.Results, string(raw)
	}
	sources := func(rs []map[string]any) []string {
		var s []string
		for _, r := range rs {
			s = append(s, r["source"].(string))
		}
		return s
	}

	code, rs, raw := search(url.Values{"q": {"quokka"}, "source": {"history"}})
	require.Equal(t, 200, code, raw)
	require.Len(t, rs, 3, raw)
	assert.Equal(t, "history", rs[0]["source"])
	assert.Equal(t, old, rs[0]["session"])
	assert.Equal(t, "assistant", rs[0]["state"])
	assert.Equal(t, "2026-11-01T08:00:05Z", rs[0]["at"], "newest first")
	assert.Contains(t, rs[0]["snippet"], "quokka")

	code, rs, raw = search(url.Values{"q": {"quokka"}}) // the default mix includes the past chats
	require.Equal(t, 200, code, raw)
	assert.Equal(t, []string{"history", "history", "history"}, sources(rs), raw)

	_, rs, raw = search(url.Values{"q": {"quokka"}, "author": {"user"}})
	require.Len(t, rs, 1, raw)
	assert.Equal(t, "user", rs[0]["state"])
	assert.EqualValues(t, 0, rs[0]["id"], "the turn's index in its session")

	_, rs, raw = search(url.Values{"q": {"quokka"}, "source": {"history"}, "since": {"2026-10-15T00:00:00Z"}})
	require.Len(t, rs, 1, raw)
	_, rs, raw = search(url.Values{"q": {"quokka"}, "source": {"history"}, "until": {"2026-10-15T00:00:00Z"}})
	require.Len(t, rs, 2, raw)

	_, rs, raw = search(url.Values{"q": {"quokka"}, "source": {"history"}, "agent": {"dev"}})
	assert.Len(t, rs, 3, raw)
	_, rs, raw = search(url.Values{"q": {"quokka"}, "source": {"history"}, "agent": {"someone-else"}})
	assert.Len(t, rs, 0, raw)

	code, _, raw = search(url.Values{"q": {"quokka"}, "author": {"robot"}})
	assert.Equal(t, 400, code, raw)
	code, _, raw = search(url.Values{"q": {"quokka"}, "agent": {"dev"}, "state": {"open"}})
	assert.Equal(t, 400, code, "filters of different sources need --source named: "+raw)
}
