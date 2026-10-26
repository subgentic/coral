package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The help pages and the flag errors of coral-board, byte for byte (testdata/cli_golden.txt): the helpers they share with coral-agent
// (clihelp) must not change one character of what a person or an agent reads. Regenerate with UPDATE_CLI_GOLDEN=1 only for a change
// that is meant to change the text.
func TestCLIHelpAndFlagErrorsAreGolden(t *testing.T) {
	cases := [][]string{
		{}, {"help"}, {"--help"}, {"help", "windows"}, {"help", "exit-codes"}, {"help", "json"}, {"help", "timeouts"}, {"help", "bogus"},
		{"help", "post"}, {"help", "task"}, {"help", "goal"}, {"task", "--help"},
		{"task", "detail", "--bogus"}, {"task", "detail", "--json", "1", "--bogus"}, {"task", "show", "--bogus", "1"}, {"task", "current", "--bogus"},
		{"task", "list", "--bogus"}, {"goal", "show", "--bogus"}, {"goal", "list", "--bogus"}, {"post", "--bogus", "x"}, {"send", "--bogus", "x"},
	}
	rs := newRecordingServer(t)
	var got strings.Builder
	for _, args := range cases {
		r := runBoard(t, rs.URL, t.TempDir(), args...)
		fmt.Fprintf(&got, "=== coral-board %s\nexit %d\n--- stdout\n%s--- stderr\n%s", strings.Join(args, " "), r.code,
			strings.ReplaceAll(r.stdout, rs.URL, "SERVER"), strings.ReplaceAll(r.stderr, rs.URL, "SERVER"))
		if !strings.HasSuffix(r.stdout, "\n") && r.stdout != "" {
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
