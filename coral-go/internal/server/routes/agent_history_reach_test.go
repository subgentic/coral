package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #11048: the levels of chat history search. Every session holds a canary: Dev (the caller), Peer (its teammate), Other (another team's agent, launched by Coral) and Indexed (a CLI session Coral only found on
// disk). Each level reaches exactly its own set, and a request above the caller's level is refused with the level needed and no text.
func TestAgentHistoryReachLevels(t *testing.T) {
	env := setupAgentHistoryTestEnv(t)
	ctx := context.Background()
	ts := store.NewTeamStore(env.handler.db)
	env.handler.teamStore = ts

	workDir := filepath.Join(env.claudeHome, "reach-project")
	require.NoError(t, os.MkdirAll(workDir, 0o755))
	projDir := filepath.Join(env.claudeHome, transcriptlink.ClaudeProjectDirName(workDir))
	require.NoError(t, os.MkdirAll(projDir, 0o755))
	write := func(sid, canary string) string {
		f := filepath.Join(projDir, sid+".jsonl")
		line := fmt.Sprintf(`{"type":"user","timestamp":"2026-09-30T08:00:00Z","message":{"content":"the shared topic zebra %s"}}`+"\n", canary)
		require.NoError(t, os.WriteFile(f, []byte(line), 0o644))
		return f
	}
	live := func(sid, name, canary string) {
		write(sid, canary)
		require.NoError(t, env.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Claude, AgentName: name, WorkingDir: workDir}))
	}
	const (
		dev     = "00000000-0000-4000-8000-0000000011a0"
		peer    = "00000000-0000-4000-8000-0000000011a1"
		other   = "00000000-0000-4000-8000-0000000011a2"
		indexed = "00000000-0000-4000-8000-0000000011a3"
	)
	live(dev, "dev", "CANARY-DEV")
	live(peer, "peer", "CANARY-PEER")
	live(other, "other", "CANARY-OTHER")
	f := write(indexed, "CANARY-INDEXED")
	first, last := "2026-09-30T08:00:00Z", "2026-09-30T08:00:00Z"
	require.NoError(t, env.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: indexed, SourceType: "claude", SourceFile: f, FirstTimestamp: &first, LastTimestamp: &last, MessageCount: 1}))

	mk := func(team, agent, sid string) *store.TeamMember {
		tm, err := ts.GetTeam(ctx, team)
		require.NoError(t, err)
		if tm == nil {
			tm, err = ts.CreateTeam(ctx, &store.Team{Name: team, ConfigJSON: `{}`})
			require.NoError(t, err)
		}
		m, err := ts.CreateTeamMember(ctx, &store.TeamMember{TeamID: tm.ID, AgentName: agent, AgentConfigJSON: `{}`, SessionID: &sid})
		require.NoError(t, err)
		require.NoError(t, env.ss.SetTeamID(ctx, sid, tm.ID))
		return m
	}
	devM := mk("team-a", "dev", dev)
	mk("team-a", "peer", peer)
	mk("team-b", "other", other)

	get := func(path string) (int, map[string]any, string) {
		req, _ := http.NewRequest("GET", env.server.URL+path, nil)
		req.Header.Set(testAgentHeader, dev)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out, string(raw)
	}
	search := func(reach string) (int, map[string]any, string) {
		p := "/api/agent/history/search?query=zebra"
		if reach != "" {
			p += "&reach=" + reach
		}
		return get(p)
	}
	canaries := func(raw string) string {
		var seen []string
		for _, c := range []string{"CANARY-DEV", "CANARY-PEER", "CANARY-OTHER", "CANARY-INDEXED"} {
			if strings.Contains(raw, c) {
				seen = append(seen, c)
			}
		}
		return strings.Join(seen, ",")
	}
	raise := func(level string) {
		_, err := ts.SetSearchReach(ctx, devM.ID, level, "operator", "dashboard")
		require.NoError(t, err)
	}

	code, _, raw := search("")
	require.Equal(t, http.StatusOK, code, raw)
	assert.Equal(t, "CANARY-DEV", canaries(raw), "no flag at own: only the caller's own lineage")

	for _, reach := range []string{"team", "all", "operator"} {
		code, out, raw := search(reach)
		assert.Equal(t, http.StatusForbidden, code, "%s: %s", reach, raw)
		assert.Equal(t, "search_reach_refused", out["code"])
		assert.Equal(t, reach, out["needed"])
		assert.Equal(t, "", canaries(raw), "%s: a refusal carries no text", reach)
	}

	raise("team")
	code, _, raw = search("team")
	require.Equal(t, http.StatusOK, code, raw)
	assert.Equal(t, "CANARY-DEV,CANARY-PEER", canaries(raw), "team: its teammates' chats, not another team's, not the indexed")
	code, _, raw = search("")
	require.Equal(t, http.StatusOK, code, raw)
	assert.Equal(t, "CANARY-DEV", canaries(raw), "no flag is own whatever the level")
	code, out, raw := search("all")
	assert.Equal(t, http.StatusForbidden, code, raw)
	assert.Equal(t, "team", out["level"])

	raise("all")
	code, _, raw = search("all")
	require.Equal(t, http.StatusOK, code, raw)
	assert.Equal(t, "CANARY-DEV,CANARY-PEER,CANARY-OTHER", canaries(raw), "all: everything Coral launched, not the operator's indexed CLI history")
	code, _, raw = search("operator")
	assert.Equal(t, http.StatusForbidden, code, raw)
	assert.Equal(t, "", canaries(raw))

	raise("operator")
	code, _, raw = search("operator")
	require.Equal(t, http.StatusOK, code, raw)
	assert.Equal(t, "CANARY-DEV,CANARY-PEER,CANARY-OTHER,CANARY-INDEXED", canaries(raw))

	code, _, raw = search("bogus")
	assert.Equal(t, http.StatusBadRequest, code, raw)

	// Context follows the same set: a target outside the caller's reach is refused, inside it is read.
	ctxOf := func(target, reach string) (int, string) {
		p := fmt.Sprintf("/api/agent/history/context?message_index=0&target_session_id=%s", target)
		if reach != "" {
			p += "&reach=" + reach
		}
		code, _, raw := get(p)
		return code, raw
	}
	raise("team")
	code, raw = ctxOf(peer, "team")
	assert.Equal(t, http.StatusOK, code, raw)
	assert.Contains(t, raw, "CANARY-PEER")
	code, raw = ctxOf(peer, "")
	assert.Equal(t, http.StatusForbidden, code, "without the flag a teammate's session is outside the caller's lineage: %s", raw)
	code, raw = ctxOf(other, "team")
	assert.Equal(t, http.StatusForbidden, code, raw)
	assert.NotContains(t, raw, "CANARY")
	code, raw = ctxOf(indexed, "all")
	assert.Equal(t, http.StatusForbidden, code, "all does not carry the indexed history: %s", raw)

	// The caller's level is its own row's: Peer at own does not borrow Dev's level.
	raise("all")
	req, _ := http.NewRequest("GET", env.server.URL+"/api/agent/history/search?query=zebra&reach=all", nil)
	req.Header.Set(testAgentHeader, peer)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}
