package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/hooks"
)

// A tool call that ended is posted without the agent waiting for Coral (the short wait), the Stop event waits for Coral's answer (the long one).
func TestPostEventWaitsLessForAToolCallThanForAStop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(hooks.FastTimeout + 700*time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	event := map[string]any{"event_type": "tool_use"}

	start := time.Now()
	require.False(t, postEvent(srv.URL, "dev", "PostToolUse", event), "the short wait ends before Coral answers")
	require.Less(t, time.Since(start), hooks.FastTimeout+500*time.Millisecond)

	require.True(t, postEvent(srv.URL, "dev", "Stop", event), "a Stop waits for the answer")
}
