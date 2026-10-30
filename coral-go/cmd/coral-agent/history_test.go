package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCLIHistorySearch_MockServer(t *testing.T) {
	// Setup mock server
	var requestedQuery, requestedRoles string
	var requestedLimit, requestedOffset string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/history/search" {
			q := r.URL.Query()
			requestedQuery = q.Get("query")
			requestedRoles = q.Get("roles")
			requestedLimit = q.Get("limit")
			requestedOffset = q.Get("offset")

			resp := map[string]any{
				"query":         requestedQuery,
				"status":        "complete",
				"total_matches": 1,
				"has_more":      false,
				"limit":         10,
				"offset":        0,
				"results": []map[string]any{
					{
						"session_id":    "test-sess-uuid",
						"is_current":    true,
						"message_index": 5,
						"role":          "assistant",
						"timestamp":     "2026-09-30T12:00:00Z",
						"excerpt":       "...I configured port 8420...",
					},
				},
				"sessions_searched": []map[string]any{
					{
						"session_id":        "test-sess-uuid",
						"role":              "current",
						"status":            "ready",
						"messages_searched": 12,
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	// Point serverURL to test server
	origURL := serverURL
	serverURL = ts.URL
	defer func() { serverURL = origURL }()

	// Mock session env var
	// A real Coral session name ({type}-{uuid}) and no TMUX, so the session
	// resolves from this variable in a clean environment (CI) instead of
	// exiting, and never from the tmux session the test happens to run in.
	t.Setenv("TMUX", "")
	t.Setenv("CORAL_SESSION_NAME", "claude-00000000-0000-4000-8000-0000000000a1")

	// Verify cmdHistorySearch with flags
	cmdHistorySearch([]string{"port 8420", "--roles", "assistant", "--limit", "5", "--offset", "2"})

	assert.Equal(t, "port 8420", requestedQuery)
	assert.Equal(t, "assistant", requestedRoles)
	assert.Equal(t, "5", requestedLimit)
	assert.Equal(t, "2", requestedOffset)
}

func TestCLIHistoryContext_MockServer(t *testing.T) {
	var requestedSession string
	var requestedIndex string
	var requestedWindow string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/history/context" {
			q := r.URL.Query()
			requestedSession = q.Get("target_session_id")
			requestedIndex = q.Get("message_index")
			requestedWindow = q.Get("window")

			resp := map[string]any{
				"session_id":     requestedSession,
				"target_index":   5,
				"total_messages": 10,
				"window":         2,
				"messages": []map[string]any{
					{
						"message_index": 4,
						"role":          "user",
						"timestamp":     "2026-09-30T11:59:00Z",
						"content":       "What is the port?",
						"is_target":     false,
					},
					{
						"message_index": 5,
						"role":          "assistant",
						"timestamp":     "2026-09-30T12:00:00Z",
						"content":       "The port is 8420.",
						"is_target":     true,
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origURL := serverURL
	serverURL = ts.URL
	defer func() { serverURL = origURL }()

	// A real Coral session name ({type}-{uuid}) and no TMUX, so the session
	// resolves from this variable in a clean environment (CI) instead of
	// exiting, and never from the tmux session the test happens to run in.
	t.Setenv("TMUX", "")
	t.Setenv("CORAL_SESSION_NAME", "claude-00000000-0000-4000-8000-0000000000a1")

	// Call context with explicit session and index
	cmdHistoryContext([]string{"custom-ancestor-uuid", "5", "--window", "3"})

	assert.Equal(t, "custom-ancestor-uuid", requestedSession)
	assert.Equal(t, "5", requestedIndex)
	assert.Equal(t, "3", requestedWindow)
}

// #11048: --team, --all and --operator-history ask for a wider reach on purpose; they are sent as reach, never swallow the query that follows, and the flag with no value on it is own.
func TestCLIHistoryReachFlags(t *testing.T) {
	var searchReach, searchQuery, ctxReach []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch r.URL.Path {
		case "/api/agent/history/search":
			searchReach = append(searchReach, q.Get("reach"))
			searchQuery = append(searchQuery, q.Get("query"))
			json.NewEncoder(w).Encode(map[string]any{"query": q.Get("query"), "status": "complete", "results": []any{}, "sessions_searched": []any{}})
		case "/api/agent/history/context":
			ctxReach = append(ctxReach, q.Get("reach"))
			json.NewEncoder(w).Encode(map[string]any{"session_id": "s", "target_index": 0, "total_messages": 1, "window": 2, "messages": []any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	origURL := serverURL
	serverURL = ts.URL
	defer func() { serverURL = origURL }()
	t.Setenv("TMUX", "")
	t.Setenv("CORAL_SESSION_NAME", "claude-00000000-0000-4000-8000-0000000000a1")

	cmdHistorySearch([]string{"zebra"})
	cmdHistorySearch([]string{"--team", "zebra"})
	cmdHistorySearch([]string{"zebra", "--all"})
	cmdHistorySearch([]string{"--operator-history", "zebra", "stripes"})
	assert.Equal(t, []string{"", "team", "all", "operator"}, searchReach)
	assert.Equal(t, []string{"zebra", "zebra", "zebra", "zebra stripes"}, searchQuery, "a reach flag does not take the query as its value")

	cmdHistoryContext([]string{"--team", "other-session", "3"})
	assert.Equal(t, []string{"team"}, ctxReach)
}
