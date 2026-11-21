package healthcheck

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOutputLinesAreDataNotCommands(t *testing.T) {
	in := strings.Join([]string{
		`{"key":"pr-14-stale","text":"PR 14 open 26 h","level":"warn","to":"Dev One"}`,
		`{"key":"a","text":"hello \u001b[31mred\u001b[0m and ‮evil"}`,
		`not json`,
		`{"key":"bad key!","text":"x"}`,
		`{"key":"k","text":"x","level":"loud"}`,
		`{"key":"long","text":"` + strings.Repeat("y", 500) + `"}`,
		`{"key":"two","text":"line one\nline two"}`,
	}, "\n")
	lines, bad := ParseOutput(in)
	require.Len(t, lines, 4, "%+v", lines)
	assert.Equal(t, Line{Key: "pr-14-stale", Text: "PR 14 open 26 h", Level: "warn", To: "Dev One"}, lines[0])
	assert.Equal(t, "hello red and evil", lines[1].Text, "control, ANSI and bidi characters are stripped")
	assert.Equal(t, "info", lines[1].Level, "the default level")
	assert.Len(t, []rune(lines[2].Text), MaxText, "text is cut at 200 characters")
	assert.Equal(t, "line one line two", lines[3].Text, "one line")
	assert.Equal(t, 3, bad, "not json, a bad key, a bad level: dropped and counted")
}

func TestAtMost20LinesAreKept(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString(`{"key":"k` + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `","text":"t"}` + "\n")
	}
	lines, _ := ParseOutput(b.String())
	assert.Len(t, lines, MaxLines)
}

func TestNamesAndKeys(t *testing.T) {
	for _, ok := range []string{"a", "stale-prs", "x1-2"} {
		assert.True(t, ValidName(ok), ok)
	}
	for _, bad := range []string{"", "A", "has space", "-x", strings.Repeat("a", 41), "a/b", "..", "a_b"} {
		assert.False(t, ValidName(bad), bad)
	}
	assert.True(t, ValidKey("pr-14:stale._x"))
	assert.False(t, ValidKey(""))
	assert.False(t, ValidKey(strings.Repeat("k", 65)))
	assert.False(t, ValidKey("a b"))
}

func TestEnvIsBuiltFromNothing(t *testing.T) {
	t.Setenv("CORAL_SECRET_KEY", "s3cret")
	t.Setenv("CORAL_CLOUD_URL", "https://hub.example")
	t.Setenv("ANTHROPIC_API_KEY", "sk-live")
	t.Setenv("CORAL_BOARD_TOKEN", "agent-token")
	env := Env(EnvInput{BoardURL: "http://127.0.0.1:8420", Board: "team", Token: "chk-1"})
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	assert.Equal(t, "http://127.0.0.1:8420", m["CORAL_BOARD_URL"])
	assert.Equal(t, "team", m["CORAL_BOARD"])
	assert.Equal(t, "chk-1", m["CORAL_CHECK_TOKEN"])
	for k := range m {
		switch k {
		case "PATH", "HOME", "TMPDIR", "TEMP", "LANG", "CORAL_BOARD_URL", "CORAL_BOARD", "CORAL_CHECK_TOKEN", "USERPROFILE", "SYSTEMROOT":
		default:
			t.Errorf("unexpected variable %q", k)
		}
	}
}

func script(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell scripts: unix")
	}
	p := filepath.Join(t.TempDir(), "check.sh")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o700))
	return p
}

func TestRunReadsLinesAndClosesStdin(t *testing.T) {
	p := script(t, `cat >/dev/null; echo '{"key":"a","text":"hi"}'`)
	r := Run(context.Background(), Spec{Path: p, Dir: t.TempDir(), Timeout: 5 * time.Second})
	require.NoError(t, r.Err)
	assert.Equal(t, 0, r.ExitCode)
	require.Len(t, r.Lines, 1)
	assert.Equal(t, "hi", r.Lines[0].Text)
}

func TestRunNonZeroExitIsAFailure(t *testing.T) {
	p := script(t, `echo '{"key":"a","text":"hi"}'; exit 3`)
	r := Run(context.Background(), Spec{Path: p, Dir: t.TempDir(), Timeout: 5 * time.Second})
	assert.Equal(t, 3, r.ExitCode)
	assert.True(t, r.Failed())
	assert.Equal(t, "exit 3", r.FailureReason())
}

func TestRunTimeoutKillsTheWholeGroup(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "alive")
	p := script(t, `(sleep 2; echo late > `+marker+`) & sleep 30`)
	start := time.Now()
	r := Run(context.Background(), Spec{Path: p, Dir: t.TempDir(), Timeout: 300 * time.Millisecond})
	assert.True(t, r.TimedOut)
	assert.True(t, r.Failed())
	assert.Equal(t, "timeout", r.FailureReason())
	assert.Less(t, time.Since(start), 5*time.Second)
	time.Sleep(2500 * time.Millisecond)
	_, err := os.Stat(marker)
	assert.True(t, os.IsNotExist(err), "the child of the script was killed with it")
}

func TestRunKillsAProcessThatWritesPastTheCap(t *testing.T) {
	p := script(t, `while true; do echo '{"key":"a","text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'; done`)
	start := time.Now()
	r := Run(context.Background(), Spec{Path: p, Dir: t.TempDir(), Timeout: 20 * time.Second})
	assert.Less(t, time.Since(start), 10*time.Second, "killed at the cap, not at the timeout")
	assert.True(t, r.Truncated)
	assert.LessOrEqual(t, len(r.Lines), MaxLines)
}

func TestRunUsesOnlyTheGivenEnvironment(t *testing.T) {
	t.Setenv("CORAL_SECRET_KEY", "s3cret")
	p := script(t, `echo "{\"key\":\"e\",\"text\":\"[${CORAL_SECRET_KEY}][${CORAL_CHECK_TOKEN}]\"}"`)
	r := Run(context.Background(), Spec{Path: p, Dir: t.TempDir(), Timeout: 5 * time.Second, Env: Env(EnvInput{Token: "tok"})})
	require.Len(t, r.Lines, 1)
	assert.Equal(t, "[][tok]", r.Lines[0].Text)
}

func TestSnapshotCopiesOnceAndRunsOnlyTheCopy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix modes")
	}
	src := script(t, `echo one`)
	dir := t.TempDir()
	hash, snap, err := Snapshot(src, dir)
	require.NoError(t, err)
	assert.Len(t, hash, 64)
	assert.Equal(t, filepath.Join(dir, hash), snap)
	fi, err := os.Stat(snap)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o500), fi.Mode().Perm(), "owner-only and read-only")
	require.NoError(t, os.WriteFile(src, []byte("#!/bin/sh\necho two\n"), 0o700))
	b, _ := os.ReadFile(snap)
	assert.Contains(t, string(b), "one", "a later edit of the original changes nothing")
	sum, err := HashFile(snap)
	require.NoError(t, err)
	assert.Equal(t, hash, sum)
	// A second snapshot of the same bytes is the same file.
	_, again, err := Snapshot(src, dir)
	require.NoError(t, err)
	assert.NotEqual(t, snap, again, "the changed script is a new snapshot")
}

func TestSnapshotRefusesALinkLeaf(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix links")
	}
	src := script(t, `echo x`)
	sym := filepath.Join(t.TempDir(), "sym.sh")
	require.NoError(t, os.Symlink(src, sym))
	_, _, err := Snapshot(sym, t.TempDir())
	assert.Error(t, err, "a symlink is refused")
	hard := filepath.Join(filepath.Dir(src), "hard.sh")
	require.NoError(t, os.Link(src, hard))
	_, _, err = Snapshot(hard, t.TempDir())
	assert.Error(t, err, "a hard link is refused")
}

func TestApprovedRecordChangesWithAnyField(t *testing.T) {
	base := Record{ScriptHash: "h", Args: []string{"a", "b"}, Dir: "/d", Every: "30m", To: "Dev", ActsAs: "Dev One", Env: []string{"CORAL_BOARD"}}
	h0 := base.Hash()
	assert.Equal(t, h0, base.Hash(), "stable")
	for name, mut := range map[string]func(r *Record){
		"hash":  func(r *Record) { r.ScriptHash = "h2" },
		"args":  func(r *Record) { r.Args = []string{"a", "c"} },
		"order": func(r *Record) { r.Args = []string{"b", "a"} },
		"dir":   func(r *Record) { r.Dir = "/e" },
		"every": func(r *Record) { r.Every = "1h" },
		"to":    func(r *Record) { r.To = "Other" },
		"acts":  func(r *Record) { r.ActsAs = "Someone" },
		"env":   func(r *Record) { r.Env = nil },
		"split": func(r *Record) { r.Args = []string{"a b"} },
		"write": func(r *Record) { r.MayWrite = true },
	} {
		r := base
		mut(&r)
		assert.NotEqual(t, h0, r.Hash(), name)
	}
}

func TestRunReturnsAtTheTimeoutEvenWhenAChildLeftTheGroup(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil || runtime.GOOS == "windows" {
		t.Skip("needs python3 to start a child in its own session")
	}
	p := script(t, `python3 -c "import os,time; os.setsid(); time.sleep(30)" &`+"\nsleep 30")
	start := time.Now()
	r := Run(context.Background(), Spec{Path: p, Dir: t.TempDir(), Timeout: 500 * time.Millisecond})
	assert.True(t, r.TimedOut)
	assert.Less(t, time.Since(start), 5*time.Second, "the pipe is closed with the context, a setsid child cannot hold Run")
}

func TestSnapshotOfAMultibyteScriptKeepsItWhole(t *testing.T) {
	src := script(t, "echo 'héllo'")
	_, snap, err := Snapshot(src, t.TempDir())
	require.NoError(t, err)
	b, _ := os.ReadFile(snap)
	assert.Contains(t, string(b), "héllo")
}
