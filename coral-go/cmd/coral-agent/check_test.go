package main

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckStateCommandUsesOnlyTheTriggerRouteAndBoundedFields(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "POST", r.Method)
		require.Equal(t, "/api/chief/triggers/31/state", r.URL.Path)
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "done", body["state"])
		require.Equal(t, "Nothing new", body["summary"])
		require.NotContains(t, body, "session_id")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":31,"state":"done"}`))
	}))
	defer srv.Close()
	old := serverURL
	serverURL = srv.URL
	defer func() { serverURL = old }()
	require.NoError(t, runCheck([]string{"state", "31", "--state", "done", "--summary", "Nothing new"}))
	require.Equal(t, 1, calls)
	require.Error(t, runCheck([]string{"state", "31", "--state", "done", "--summary", strings.Repeat("x", 2049)}))
	require.Equal(t, 1, calls)
	require.Error(t, runCheck([]string{"state", "0", "--state", "done"}))
	require.Error(t, runCheck([]string{"state", "31", "--state", "invented"}))
}
