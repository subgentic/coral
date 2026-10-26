package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
)

// The command line of coral's main(), byte for byte (testdata/main_golden.txt): every server flag with its default and its words (--help-all), and what
// each refusal before the server starts says and exits with (a bad value, a bad flag, a stray word, a wrong Hub mode). The refactor of main
// into named steps (#8272) must leave all of it as it is. Regenerate with UPDATE_MAIN_GOLDEN=1 only for a change meant to change the text.
func TestMainCommandLineIsGolden(t *testing.T) {
	if args := os.Getenv("CORAL_TEST_MAIN_GOLDEN_ARGS"); args != "" {
		os.Args = append([]string{"coral"}, strings.Split(args, " ")...)
		main()
		return
	}
	cases := []string{
		"--help-all",
		"--no-browser --port abc",
		"--no-browser --port",
		"--no-browser --cloud-max-mode bogus",
		"--no-browser --cloud-connect bogus",
		"--no-browser --agent-priority bogus --encryption-self-test",
		"--no-browser stop",
		"--no-browser --no-such-flag",
		"-h",
	}
	logLine := regexp.MustCompile(`(?m)^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? .*\n`)
	var got strings.Builder
	for _, args := range cases {
		dataDir, home := t.TempDir(), t.TempDir()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMainCommandLineIsGolden$")
		cmd.Env = append(cleanEnv(), "CORAL_TEST_MAIN_GOLDEN_ARGS="+args, "CORAL_DATA_DIR="+dataDir, "HOME="+home,
			"CORAL_PORT="+strconv.Itoa(closedPort(t)), "CORAL_HOST=127.0.0.1")
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
		cancel()
		require.False(t, timedOut, "%s: the child must exit, not run a server", args)
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			require.NoError(t, err, args)
		}
		out := stdout.String()
		serr := logLine.ReplaceAllString(stderr.String(), "") // coral.log lines carry the time
		// the go test binary's own trailer and this platform's default address are not coral's words
		for _, s := range []*string{&out, &serr} {
			*s = strings.ReplaceAll(*s, "PASS\n", "")
			*s = strings.ReplaceAll(*s, fmt.Sprintf("http://localhost:%d", config.DefaultPort), "http://localhost:DEFAULTPORT")
			*s = strings.ReplaceAll(*s, fmt.Sprintf("(default %d)", config.DefaultPort), "(default DEFAULTPORT)")
		}
		fmt.Fprintf(&got, "=== coral %s\nexit %d\n--- stdout\n%s--- stderr\n%s", args, code, out, serr)
		if !strings.HasSuffix(out, "\n") && out != "" {
			got.WriteString("\n")
		}
	}
	path := "testdata/main_golden.txt"
	if os.Getenv("UPDATE_MAIN_GOLDEN") == "1" {
		require.NoError(t, os.WriteFile(path, []byte(got.String()), 0o644))
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "run with UPDATE_MAIN_GOLDEN=1 once to write it")
	require.Equal(t, string(want), got.String())
}
