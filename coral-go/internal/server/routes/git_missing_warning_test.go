package routes

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"testing"
)

// With no git on PATH every poll of the Files panel used to log a warning per git command; now the first says git is missing and the rest are debug lines.
func TestAMissingGitIsWarnedAboutOnceNotOnEveryPoll(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(old) })
	gitMissingOnce = sync.Once{}

	missing := fmt.Errorf("run: %w", &exec.Error{Name: "git", Err: exec.ErrNotFound})
	for i := 0; i < 20; i++ {
		warnGit("git diff --numstat failed", missing, "agent_name", "a")
		warnGit("git ls-files (untracked) failed", missing, "agent_name", "a")
	}
	if n := strings.Count(buf.String(), "level=WARN"); n != 1 {
		t.Fatalf("a missing git logged %d warnings, want 1:\n%s", n, buf.String())
	}
	if !strings.Contains(buf.String(), "git is not on PATH") {
		t.Fatalf("the one warning does not say git is missing: %s", buf.String())
	}

	// any other failure still warns every time
	buf.Reset()
	other := errors.New("exit status 128")
	warnGit("git diff --numstat failed", other, "agent_name", "a")
	warnGit("git diff --numstat failed", other, "agent_name", "a")
	if n := strings.Count(buf.String(), "level=WARN"); n != 2 {
		t.Fatalf("other failures logged %d warnings, want 2:\n%s", n, buf.String())
	}
}
