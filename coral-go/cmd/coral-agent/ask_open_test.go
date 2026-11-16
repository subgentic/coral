package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// coral-agent ask --open names a page of Coral from a fixed list and nothing else (#18768).
func TestAskOpenTakesOnlyAPageOfCoral(t *testing.T) {
	var sent []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		sent = append(sent, m)
		w.Write([]byte(`{"id":1}`))
	}))
	defer srv.Close()
	old := serverURL
	serverURL = srv.URL
	defer func() { serverURL = old }()

	var out bytes.Buffer
	require.NoError(t, cmdAsk([]string{"Open Analytics and look around.", "--open", "analytics", "--option", "Done", "--option", "Skip this step"}, &out))
	require.Len(t, sent, 1)
	assert.Equal(t, "analytics", sent[0]["open"])
	assert.Equal(t, []any{"Done", "Skip this step"}, sent[0]["options"])
	require.NoError(t, cmdAsk([]string{"Open Settings.", "--open", "Settings"}, &out))
	assert.Equal(t, "settings", sent[1]["open"], "the name is not case sensitive")

	for _, bad := range []string{"https://example.com", "/analytics", "javascript:alert(1)", "../settings", "nowhere", ""} {
		err := cmdAsk([]string{"Look.", "--open", bad}, &out)
		require.Error(t, err, bad)
		assert.Contains(t, err.Error(), "analytics, settings", bad)
	}
	assert.Error(t, cmdAsk([]string{"Look.", "--open", "analytics", "--open", "settings"}, &out), "one page per question")
	assert.Len(t, sent, 2, "a refused page sends nothing")
	assert.Contains(t, askUsageText, "--open PAGE")
}
