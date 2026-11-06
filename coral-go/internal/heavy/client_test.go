package heavy

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13750 (Security's MUST 2, sending side): the file list is git's own, minus symlinks that leave the worktree and secret-looking names, with caps; the ssh command line is fixed; the exit code is the wrapper's trailer.

func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		c := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...)
		out, err := c.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run("init", "-q")
	return dir
}

func put(t *testing.T, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, name)
	require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
	require.NoError(t, os.WriteFile(p, []byte(body), 0o644))
}

func TestFileListIsGitsOwnMinusIgnoredFilesLinksOutAndSecrets(t *testing.T) {
	dir := gitRepo(t)
	put(t, dir, ".gitignore", "ignored.txt\nbuild/\n")
	put(t, dir, "src/main.go", "package main")
	put(t, dir, "untracked.txt", "new file, not added")
	put(t, dir, "ignored.txt", "ignored by git")
	put(t, dir, "build/out.bin", "ignored folder")
	put(t, dir, ".env", "SECRET=1")
	put(t, dir, ".env.local", "SECRET=2")
	put(t, dir, "deploy/server.pem", "-----")
	put(t, dir, "deploy/server.key", "-----")
	put(t, dir, "id_rsa", "-----")
	put(t, dir, "credentials.json", "{}")
	put(t, dir, "notes/my_token.txt", "tok")
	put(t, dir, "internal/background/token_poller.go", "package background") // a TRACKED source file whose name says token: it is needed to build
	put(t, dir, "scripts/credentials.sh", "echo secret")                     // the same words, untracked: skipped whatever the extension
	put(t, dir, "notes/token.md", "a token")
	put(t, dir, "tools/tokens.py", "TOKEN = 1")
	put(t, dir, "docs/credentials_flow.md", "# docs, tracked")
	put(t, dir, "docs/credentials_flow.md", "# docs")
	outside := t.TempDir()
	put(t, outside, "secret", "x")
	links := runtime.GOOS != "windows" // links need a privilege on Windows and git there does not make them; the wrapper is for a Mac or Linux client
	if links {
		require.NoError(t, os.Symlink(filepath.Join(outside, "secret"), filepath.Join(dir, "leaks")))
		require.NoError(t, os.Symlink("src/main.go", filepath.Join(dir, "inside")))
		require.NoError(t, os.Symlink("../../../../etc/passwd", filepath.Join(dir, "up")))
	}
	c := exec.Command("git", "-C", dir, "add", "src/main.go", ".gitignore", "internal/background/token_poller.go", "docs/credentials_flow.md")
	require.NoError(t, c.Run())

	fl, err := FileList(dir, ClientLimits{Files: 1000, Bytes: 1 << 20})
	require.NoError(t, err)
	var names []string
	for _, f := range fl.Send {
		names = append(names, f.Name)
	}
	assert.Contains(t, names, "src/main.go")
	assert.Contains(t, names, "untracked.txt", "untracked and not ignored: sent")
	assert.Contains(t, names, ".gitignore")
	if links {
		assert.Contains(t, names, "inside", "a link inside the worktree is kept")
	}
	assert.Contains(t, names, "internal/background/token_poller.go", "a TRACKED source file is not a secret because of its name")
	assert.Contains(t, names, "docs/credentials_flow.md", "nor is tracked text")
	for _, no := range []string{"scripts/credentials.sh", "notes/token.md", "tools/tokens.py", "ignored.txt", "build/out.bin", ".env", ".env.local", "deploy/server.pem", "deploy/server.key", "id_rsa", "credentials.json", "notes/my_token.txt", "leaks", "up"} {
		assert.NotContains(t, names, no, no)
	}
	var said []string
	for _, s := range fl.Skipped {
		said = append(said, s.Name+": "+s.Why)
	}
	joined := strings.Join(said, "\n")
	assert.Contains(t, joined, ".env: a name that looks like a secret")
	if links {
		assert.Contains(t, joined, "leaks: a link that leaves the worktree")
		assert.Contains(t, joined, "up: a link that leaves the worktree")
	}
	assert.NotContains(t, joined, "ignored.txt", "what git ignores is not even listed")
}

func TestFileListRefusesAWorktreeOverTheCapsAndSaysHowBigItIs(t *testing.T) {
	dir := gitRepo(t)
	put(t, dir, "a.txt", strings.Repeat("x", 600))
	put(t, dir, "b.txt", strings.Repeat("y", 600))
	_, err := FileList(dir, ClientLimits{Files: 1, Bytes: 1 << 20})
	require.ErrorIs(t, err, ErrTooBig)
	assert.Contains(t, err.Error(), "2 files")
	_, err = FileList(dir, ClientLimits{Files: 10, Bytes: 1000})
	require.ErrorIs(t, err, ErrTooBig)
	assert.Contains(t, err.Error(), "1200 bytes")
}

func TestSSHArgumentsAreFixedAndTheDestinationIsTheOperatorsAliasAfterDoubleDash(t *testing.T) {
	args, err := SSHArgs("coral-heavy-mini")
	require.NoError(t, err)
	joined := strings.Join(args, " ")
	for _, want := range []string{"-T", "-a", "-x", "ControlMaster=no", "ControlPath=none", "BatchMode=yes", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no", "SendEnv=-*", "ServerAliveInterval=15"} {
		assert.Contains(t, joined, want)
	}
	require.GreaterOrEqual(t, len(args), 2)
	assert.Equal(t, []string{"--", "coral-heavy-mini"}, args[len(args)-2:], "the destination comes last, after --")
	for _, bad := range []string{"", "-oProxyCommand=touch /tmp/x", "-x", "a b", "a;b", "host:22", "user@host", "Mini", strings.Repeat("a", 60)} {
		_, err := SSHArgs(bad)
		assert.Error(t, err, "%q", bad)
	}
}

func TestSlugOfAnAgentNameIsWhatTheWrapperAccepts(t *testing.T) {
	for in, want := range map[string]string{"Lead Developer": "lead-developer", "Data Science & Dashboarding": "data-science-dashboarding", "QA Reviewer 2": "qa-reviewer-2", "--weird--": "weird", "": "agent"} {
		got := Slug(in)
		assert.Equal(t, want, got, in)
		assert.True(t, ValidAgent(got), got)
	}
	assert.True(t, ValidAgent(Slug(strings.Repeat("x", 200))))
}

func TestSplitTrailerTellsTheCommandsExitCodeFromTheWrappersAndSSHs(t *testing.T) {
	var shown bytes.Buffer
	tr := &TrailerReader{W: &shown}
	_, _ = tr.Write([]byte("some stderr\n[coral-heavy] exit 7\n"))
	assert.Equal(t, "some stderr\n", shown.String(), "the trailer line is taken out of the output")
	assert.Equal(t, "exit 7", tr.Trailer())
	// a trailer split across writes, and a program that prints something that merely looks like one in the middle
	shown.Reset()
	tr = &TrailerReader{W: &shown}
	_, _ = tr.Write([]byte("[coral-heavy] exit 0 (said by the program)\nmore\n[coral-he"))
	_, _ = tr.Write([]byte("avy] killed: time cap\n"))
	assert.Equal(t, "killed: time cap", tr.Trailer(), "the LAST line is the wrapper's")
	// a forged trailer in the middle, more output after it, and the stream just ends (the connection dropped): the forged exit code is not believed
	tr = &TrailerReader{W: io.Discard}
	_, _ = tr.Write([]byte("[coral-heavy] exit 0 (forged)\nand then the program went on printing\n"))
	assert.Equal(t, "", tr.Trailer(), "a line that is not the last thing in the stream is not the wrapper's")
	// no trailer: ssh itself failed
	tr = &TrailerReader{W: io.Discard}
	_, _ = tr.Write([]byte("ssh: connect to host failed\n"))
	assert.Equal(t, "", tr.Trailer())
}
