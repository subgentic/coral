package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
)

// The help pages and the flag errors of coral-agent, byte for byte (testdata/cli_golden.txt): see coral-board's twin. Regenerate with
// UPDATE_CLI_GOLDEN=1 only for a change that is meant to change the text.
func TestCLIHelpAndFlagErrorsAreGolden(t *testing.T) {
	cases := [][]string{
		{}, {"help"}, {"--help"}, {"help", "windows"}, {"help", "exit-codes"}, {"help", "json"}, {"help", "timeouts"}, {"help", "bogus"},
		{"help", "task"}, {"help", "artifact"}, {"help", "docs"}, {"task", "--help"},
		{"task", "list", "--bogus"}, {"task", "current", "--bogus"}, {"task", "detail", "--bogus"}, {"task", "detail", "--json", "1", "--bogus"},
		{"artifact", "--bogus"}, {"docs", "--bogus"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) }))
	t.Cleanup(srv.Close)
	var got strings.Builder
	for _, args := range cases {
		code, stdout, stderr := runAgent(t, srv.URL, args...)
		fmt.Fprintf(&got, "=== coral-agent %s\nexit %d\n--- stdout\n%s--- stderr\n%s", strings.Join(args, " "), code,
			normalize(stdout, srv.URL), normalize(stderr, srv.URL))
		if !strings.HasSuffix(stdout, "\n") && stdout != "" {
			got.WriteString("\n")
		}
	}
	path := filepath.Join("testdata", "cli_golden.txt")
	if os.Getenv("UPDATE_CLI_GOLDEN") == "1" {
		require.NoError(t, os.WriteFile(path, []byte(got.String()), 0o644))
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "run with UPDATE_CLI_GOLDEN=1 once to write it")
	require.Equal(t, string(want), got.String())
}

// normalize turns the two values that differ by run or platform into words: the test server's URL, and this platform's default port (8420, but
// 8450 on Windows, config.DefaultPort), which the help text names. Everything else stays byte for byte.
func normalize(out, serverURL string) string {
	out = strings.ReplaceAll(out, serverURL, "SERVER")
	return strings.ReplaceAll(out, fmt.Sprintf("http://localhost:%d", config.DefaultPort), "http://localhost:DEFAULTPORT")
}
