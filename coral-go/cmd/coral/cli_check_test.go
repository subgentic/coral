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
	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/cloud"
)

func TestCLICheckSignedResultsAndFailures(t *testing.T) {
	home := t.TempDir()
	token, err := cloud.WriteCLIToken(home)
	require.NoError(t, err)
	auth := cloud.NewCLIAuth(token)
	var types []string
	reply := `{"found":true,"path":"/opt/claude","version":"1.2.3"}`
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path == cloud.CLIHelloPath {
			var h struct {
				Nonce string `json:"nonce"`
			}
			require.NoError(t, json.Unmarshal(body, &h))
			nonce, proof, err := auth.Hello(h.Nonce)
			require.NoError(t, err)
			json.NewEncoder(w).Encode(map[string]string{"nonce": nonce, "proof": proof})
			return
		}
		require.True(t, auth.Verify(r, body), "request must be signed")
		assert.Equal(t, "GET", r.Method)
		assert.Equal(t, "/api/system/cli-check", r.URL.Path)
		types = append(types, r.URL.Query().Get("type"))
		w.WriteHeader(status)
		io.WriteString(w, reply)
	}))
	defer srv.Close()
	run := func(args ...string) (int, string, string) {
		var out, errb bytes.Buffer
		code := runCLICheck(append(args, "--home", home, "--url", srv.URL), &out, &errb)
		return code, out.String(), errb.String()
	}
	code, out, errb := run("claude")
	require.Zero(t, code, errb)
	assert.Equal(t, "claude: found; path: /opt/claude; version: 1.2.3\n", out)
	assert.Equal(t, []string{"claude"}, types)
	types = nil
	code, _, errb = run()
	require.Zero(t, code, errb)
	assert.Equal(t, agent.CLITypes(), types)
	reply = `{"found":false,"binary":"codex","message":"configured path cannot be run"}`
	code, out, _ = run("codex")
	assert.Equal(t, 1, code)
	assert.Contains(t, out, "codex: not found; path: codex; version: -")
	assert.Contains(t, out, "configured path cannot be run")
	code, _, errb = run()
	assert.Zero(t, code, errb)
	for _, bad := range [][]string{{"terminal"}, {"unknown"}, {"claude", "codex"}} {
		code, _, _ = run(bad...)
		assert.Equal(t, 2, code)
	}
	status = 403
	reply = `{"error":"operator only"}`
	code, out, errb = run("claude")
	assert.Equal(t, 1, code)
	assert.Empty(t, out)
	assert.Contains(t, errb, "operator only")
	status = 200
	reply = `{}`
	code, _, _ = run("claude")
	assert.Equal(t, 1, code)
	reply = `bad JSON`
	code, _, _ = run("claude")
	assert.Equal(t, 1, code)
}

func TestCLICheckRequiresLocalTokenAndValidUsage(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, 2, runCLICheck([]string{"claude", "--home", t.TempDir(), "--url", "http://127.0.0.1:1"}, &out, &errb))
	assert.Contains(t, errb.String(), "command-line token")
	errb.Reset()
	assert.Equal(t, 2, runCLICheck([]string{"--url", "https://example.com"}, &out, &errb))
	assert.Contains(t, errb.String(), "only talks to the Coral running here")
	_, ok := findCommand("cli-check")
	assert.True(t, ok)
}
