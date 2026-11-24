package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #21057: GET /api/analytics/waste, the waste line per agent: the re-read share of input from the usage rows, cache expiries and idle compactions from a Claude transcript (null for another vendor, never a
// zero), per agent name, for a range and a team; the Operator's alone.
func TestTheWasteLineIsPerAgentFromUsageAndTheTranscript(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "waste.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ts := store.NewTokenUsageStore(db)
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	at := now.Add(-2 * time.Hour).Format("2006-01-02T15:04:05.000Z")
	rec := func(sid, name, agentType, board string, in, read, write int64) {
		b := board
		u := store.TokenUsage{SessionID: sid, AgentName: name, AgentType: agentType, BoardName: &b, Model: "m", InputTokens: int(in), CacheReadTokens: int(read), CacheWriteTokens: int(write), RecordedAt: at, Source: "jsonl"}
		u.TotalTokens = int(in + read + write)
		require.NoError(t, ts.RecordUsage(t.Context(), &u))
	}
	const lead, helper, other = "21057000-0000-4000-8000-0000000000a1", "21057000-0000-4000-8000-0000000000a2", "21057000-0000-4000-8000-0000000000a3"
	rec(lead, "Lead", "claude", "alpha", 100, 700, 200)  // 1000 of input, 700 re-read: 70%
	rec(helper, "Helper", "codex", "alpha", 500, 500, 0) // 50%, a vendor with no transcript figures
	rec(other, "Other", "claude", "beta", 10, 0, 90)     // another team
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "proj"), 0o755))
	call := func(id, ts string, read, create int) string {
		return `{"type":"assistant","timestamp":"` + ts + `","message":{"id":"` + id + `","usage":{"input_tokens":3,"cache_read_input_tokens":` + strconv.Itoa(read) + `,"cache_creation_input_tokens":` + strconv.Itoa(create) + `}}}`
	}
	tr := []string{call("m1", "2026-11-24T04:00:00.000Z", 1000, 10), call("m2", "2026-11-24T04:10:00.000Z", 0, 5000),
		`{"type":"system","subtype":"compact_boundary","timestamp":"2026-11-24T04:20:00.000Z","compactMetadata":{"trigger":"manual"}}`}
	require.NoError(t, os.WriteFile(filepath.Join(dir, "proj", lead+".jsonl"), []byte(strings.Join(tr, "\n")+"\n"), 0o644))

	h := NewTokenUsageHandler(db)
	h.now = func() time.Time { return now }
	get := func(query string, mod func(*http.Request) *http.Request) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodGet, "/api/analytics/waste"+query, nil)
		if mod != nil {
			req = mod(req)
		}
		rec := httptest.NewRecorder()
		h.Waste(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	row := func(out map[string]any, agent string) map[string]any {
		for _, r := range out["rows"].([]any) {
			if m := r.(map[string]any); m["agent"] == agent {
				return m
			}
		}
		return nil
	}

	code, out := get("?days=7&team=alpha", person)
	require.Equal(t, http.StatusOK, code, "%v", out)
	l := row(out, "Lead")
	require.NotNil(t, l, "%v", out)
	assert.InDelta(t, 0.7, l["reread_share"], 1e-9)
	assert.Equal(t, 1000.0, l["input_tokens"])
	assert.Equal(t, 1.0, l["cache_expiries"], "the call after nine idle minutes that wrote its prompt again")
	assert.Equal(t, 1.0, l["idle_compactions"])
	h2 := row(out, "Helper")
	require.NotNil(t, h2)
	assert.InDelta(t, 0.5, h2["reread_share"], 1e-9)
	assert.Nil(t, h2["cache_expiries"], "a Codex agent has no such figure: null, not zero")
	assert.Nil(t, h2["idle_compactions"])
	assert.Nil(t, row(out, "Other"), "another team's agent is not in this team's line")
	tot := out["totals"].(map[string]any)
	assert.InDelta(t, 1200.0/2000.0, tot["reread_share"], 1e-9, "the team's re-read share: 1,200 of 2,000")
	assert.Equal(t, 1.0, tot["cache_expiries"])

	_, all := get("?days=7", person)
	assert.Len(t, all["rows"], 3)
	_, none := get("?days=7&team=nosuchteam", person)
	assert.Empty(t, none["rows"], "a team no row names is empty, never every team")
	assert.Equal(t, 0.0, none["totals"].(map[string]any)["reread_share"])
	_, oneDay := get("?days=1", person)
	assert.Len(t, oneDay["rows"], 3, "the usage was two hours ago")

	for _, bad := range []string{"?days=0", "?days=x", "?team=" + strings.Repeat("a", 300)} {
		code, _ := get(bad, person)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	asAgent := func(req *http.Request) *http.Request {
		const sid = "11111111-2222-4333-8444-555555555555"
		return person(req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid, SessionName: "claude-" + sid})))
	}
	code, out = get("?days=7", asAgent)
	assert.Equal(t, http.StatusForbidden, code, "an agent's token is refused")
	assert.Nil(t, out["rows"])
	code, _ = get("?days=7", nil)
	assert.Equal(t, http.StatusForbidden, code)
}
