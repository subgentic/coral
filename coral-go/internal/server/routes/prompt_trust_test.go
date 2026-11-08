package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #14110: a Needs you row may answer Claude's folder-trust menu (a lasting grant) as one named exception, found by the menu's structure and not by the word
// "trust", for a folder the screen names and Coral may trust, from the person's own dashboard.

const trustFixtureFolder = "/private/tmp/q4543/project"

func trustScreen(t *testing.T, folder string) string {
	t.Helper()
	return strings.ReplaceAll(claudeUnnumbered(t, "trust.txt"), trustFixtureFolder, folder)
}

func TestFolderTrustMenu_ByStructure(t *testing.T) {
	for _, backend := range []string{"tmux", "pty"} {
		screen := claudeUnnumbered(t, "trust.txt")
		if backend == "pty" {
			screen = ptymanager.RenderScreen([]byte(claudeUnnumbered(t, "pty_trust.raw")), 120, 40)
		}
		s, ok := parsePromptScreen(screen)
		require.True(t, ok, backend)
		assert.True(t, isFolderTrustMenu(s), backend)
		markFolderTrust(screen, &s)
		want := trustFixtureFolder
		if backend == "pty" {
			want += "2" // the raw capture is a different run's: its folder is project2
		}
		assert.Equal(t, want, s.TrustFolder, backend)
		assert.True(t, isTrustYes(s, s.Options[1]), backend)
		assert.False(t, isTrustYes(s, s.Options[0]), "No is not the grant")
	}

	// Look-alikes get nothing: another menu, other labels, a third option, another question, the word trust somewhere else.
	lookAlike := func(name, screen string) {
		t.Helper()
		s, ok := parsePromptScreen(screen)
		if !ok {
			return // not even a menu
		}
		markFolderTrust(screen, &s)
		assert.False(t, isFolderTrustMenu(s), name)
		assert.Empty(t, s.TrustFolder, name)
	}
	base := claudeUnnumbered(t, "trust.txt")
	lookAlike("the API key menu", claudeUnnumbered(t, "apikey.txt"))
	lookAlike("a lasting Yes with other words", strings.Replace(base, "Yes, I trust this folder", "Yes, always trust this folder", 1))
	lookAlike("a No with other words", strings.Replace(base, "No, exit", "No", 1))
	lookAlike("a third option", strings.Replace(base, "   Yes, I trust this folder\n", "   Yes, I trust this folder\n   Yes, and every folder under it\n", 1))
	lookAlike("another question", strings.Replace(base, "Quick safety check: Is this a project you created or one you trust?", "Do you trust this folder with your keys?", 1))
	lookAlike("options swapped", strings.Replace(strings.Replace(base, "No, exit", "TMP", 1), "Yes, I trust this folder", "No, exit", 1))

	// A trust menu with no single folder line has a case but no folder, so nothing to offer.
	noFolder := strings.Replace(base, " Accessing workspace:\n\n "+trustFixtureFolder+"\n", " Accessing workspace:\n", 1)
	s, ok := parsePromptScreen(noFolder)
	require.True(t, ok)
	markFolderTrust(noFolder, &s)
	assert.True(t, isFolderTrustMenu(s))
	assert.Empty(t, s.TrustFolder, "the question is not a folder")
}

func TestFolderTrust_RowOffer_And_Answer(t *testing.T) {
	const sid = "00000000-0000-0000-0000-00000000a5c3"
	home := t.TempDir()
	t.Setenv("HOME", home)
	project := filepath.Join(home, "work", "project")
	require.NoError(t, os.MkdirAll(project, 0o755))
	if resolved, err := filepath.EvalSymlinks(project); err == nil {
		project = resolved
	}

	type env struct {
		base      string
		setScreen func(string)
		term      *mockSessionTerminal
	}
	// setup registers the live session with workdir (the first of dirs, the project by default) as its own recorded folder; a second dir is its worktree folder.
	setup := func(t *testing.T, dirs ...string) env {
		workdir, worktree := project, ""
		if len(dirs) > 0 {
			workdir = dirs[0]
		}
		if len(dirs) > 1 {
			worktree = dirs[1]
		}
		server, handler, terminal, ss := setupSessionsTestServer(t)
		_ = handler
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-trust", WorkingDir: workdir}))
		if worktree != "" {
			require.NoError(t, ss.UpdateWorktreeInfo(context.Background(), sid, worktree, workdir))
		}
		terminal.addSession("claude-trust", "/tmp/test")
		fastPromptChecks(t)
		set := func(s string) {
			terminal.mu.Lock()
			terminal.outputs["claude-trust"] = s
			terminal.mu.Unlock()
		}
		return env{base: server.URL + "/api/sessions/live/claude-trust", setScreen: set, term: terminal}
	}
	// A request from the dashboard carries Sec-Fetch-Site (the identity middleware classifies it as the person's own page); one without it is a tool on this computer.
	do := func(t *testing.T, req *http.Request, dash bool) *http.Response {
		if dash {
			req.Header.Set("Sec-Fetch-Site", "same-origin")
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		return resp
	}
	chatAs := func(t *testing.T, e env, dash bool) promptScreen {
		req, err := http.NewRequest(http.MethodGet, e.base+"/chat?"+url.Values{"session_id": {sid}, "agent_type": {"claude"}, "after": {"1"}}.Encode(), nil)
		require.NoError(t, err)
		resp := do(t, req, dash)
		defer resp.Body.Close()
		var reply struct {
			PromptOptions promptScreen `json:"prompt_options"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&reply))
		return reply.PromptOptions
	}
	chat := func(t *testing.T, e env) promptScreen { return chatAs(t, e, true) }
	answerAs := func(t *testing.T, e env, n int, label, folder string, dash bool) (int, map[string]any) {
		payload := map[string]any{"n": n, "label": label, "session_id": sid, "agent_type": "claude"}
		if folder != "" {
			payload["trust_folder"] = folder
		}
		b, _ := json.Marshal(payload)
		req, err := http.NewRequest(http.MethodPost, e.base+"/answer-prompt", bytes.NewReader(b))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp := do(t, req, dash)
		defer resp.Body.Close()
		var body map[string]any
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body
	}
	answer := func(t *testing.T, e env, n int, label, folder string) (int, map[string]any) {
		return answerAs(t, e, n, label, folder, true)
	}

	t.Run("a folder Coral may trust is named and offered", func(t *testing.T) {
		e := setup(t)
		e.setScreen(trustScreen(t, project))
		po := chat(t, e)
		assert.Equal(t, project, po.TrustFolder)
		assert.True(t, po.TrustOffer)
	})
	t.Run("home, a hidden folder under it, a missing folder and the shared tmp are named but never offered", func(t *testing.T) {
		hidden := filepath.Join(home, ".claude", "x")
		require.NoError(t, os.MkdirAll(hidden, 0o755))
		for name, folder := range map[string]string{"home": home, "a hidden folder": hidden, "a missing folder": filepath.Join(home, "work", "gone"), "the fixture's /private/tmp": trustFixtureFolder} {
			e := setup(t, folder) // the session's own folder, so only foldertrust.Check can refuse it
			e.setScreen(trustScreen(t, folder))
			po := chat(t, e)
			assert.False(t, po.TrustOffer, name)
		}
	})
	t.Run("a tool on this computer (not the dashboard) is not offered Yes and its row Yes is refused", func(t *testing.T) {
		e := setup(t)
		e.setScreen(trustScreen(t, project))
		po := chatAs(t, e, false)
		assert.Equal(t, project, po.TrustFolder, "the folder is read for the card either way")
		assert.False(t, po.TrustOffer)
		code, body := answerAs(t, e, 2, "Yes, I trust this folder", project, false)
		assert.Equal(t, http.StatusConflict, code)
		assert.Equal(t, "trust_changed", body["code"])
		assert.Zero(t, e.term.enters["claude-trust"])
	})
	t.Run("a spoofed heading and path above the real one: no folder, no Yes", func(t *testing.T) { // Security's MUST on #14110
		e := setup(t)
		spoof := " Accessing workspace:\n\n " + filepath.Join(home, "work", "elsewhere") + "\n\n"
		e.setScreen(spoof + trustScreen(t, project))
		po := chat(t, e)
		assert.Empty(t, po.TrustFolder, "two headings: no folder")
		assert.False(t, po.TrustOffer)
		code, body := answer(t, e, 2, "Yes, I trust this folder", project)
		assert.Equal(t, http.StatusConflict, code)
		assert.Equal(t, "trust_changed", body["code"])
		assert.Zero(t, e.term.enters["claude-trust"])
	})
	t.Run("a menu for a folder other than the session's own is named but not offered", func(t *testing.T) {
		e := setup(t) // the session's folder is project
		other := filepath.Join(home, "work", "other")
		require.NoError(t, os.MkdirAll(other, 0o755))
		e.setScreen(trustScreen(t, other))
		po := chat(t, e)
		assert.Equal(t, other, po.TrustFolder)
		assert.False(t, po.TrustOffer, "a real menu for another folder: not what Coral recorded for this agent")
	})
	t.Run("the session's worktree folder counts as its own", func(t *testing.T) {
		tree := filepath.Join(home, "work", "tree")
		require.NoError(t, os.MkdirAll(tree, 0o755))
		e := setup(t, project, tree)
		e.setScreen(trustScreen(t, tree))
		po := chat(t, e)
		assert.True(t, po.TrustOffer)
	})
	t.Run("a symlinked spelling of the session's own folder is the same folder", func(t *testing.T) {
		link := filepath.Join(home, "work", "link")
		require.NoError(t, os.Symlink(project, link))
		e := setup(t)
		e.setScreen(trustScreen(t, link))
		po := chat(t, e)
		assert.True(t, po.TrustOffer)
	})
	t.Run("a look-alike menu is not offered", func(t *testing.T) {
		e := setup(t)
		e.setScreen(strings.Replace(trustScreen(t, project), "Yes, I trust this folder", "Yes, always trust this folder", 1))
		po := chat(t, e)
		assert.False(t, po.TrustOffer)
		assert.Empty(t, po.TrustFolder)
	})
	t.Run("the row's Yes goes through for the folder it drew, and the chat's own Yes needs no folder", func(t *testing.T) {
		e := setup(t)
		e.setScreen(trustScreen(t, project))
		e.term.onArrow = func(string) {
			e.setScreen(strings.Replace(trustScreen(t, project), "❯ No, exit\n   Yes, I trust this folder", "  No, exit\n ❯ Yes, I trust this folder", 1))
		}
		e.term.onEnter = func(string) { e.setScreen(claudeUnnumbered(t, "ready.txt")) }
		code, body := answer(t, e, 2, "Yes, I trust this folder", project)
		assert.Equal(t, http.StatusOK, code, "%v", body)
		assert.Equal(t, 1, e.term.enters["claude-trust"])
	})
	t.Run("the screen now names another folder: the row's Yes is refused and no key is sent", func(t *testing.T) {
		e := setup(t)
		other := filepath.Join(home, "work", "other")
		require.NoError(t, os.MkdirAll(other, 0o755))
		e.setScreen(trustScreen(t, other))
		code, body := answer(t, e, 2, "Yes, I trust this folder", project)
		assert.Equal(t, http.StatusConflict, code)
		assert.Equal(t, "trust_changed", body["code"])
		assert.Zero(t, e.term.enters["claude-trust"])
		assert.Empty(t, e.term.arrows["claude-trust"])
	})
	t.Run("a folder Coral may not trust: the row's Yes is refused even when the row names it", func(t *testing.T) {
		e := setup(t, home)
		e.setScreen(trustScreen(t, home))
		code, body := answer(t, e, 2, "Yes, I trust this folder", home)
		assert.Equal(t, http.StatusConflict, code)
		assert.Equal(t, "trust_changed", body["code"])
		assert.Zero(t, e.term.enters["claude-trust"])
	})
	t.Run("No is never held back by the folder", func(t *testing.T) {
		e := setup(t)
		e.setScreen(trustScreen(t, home))
		e.term.onEnter = func(string) { e.setScreen(claudeUnnumbered(t, "ready.txt")) }
		code, body := answer(t, e, 1, "No, exit", home)
		assert.Equal(t, http.StatusOK, code, "%v", body)
	})
}

// #14560 (Beta run 3): a long folder wraps at the terminal's width, and the folder-trust row then offered no Yes: folderTrustPath read the first line only, which is not the session's own folder. A
// member nobody has opened is at the launch width, so the first agent (opened by the person, resized) offered Yes and the later members did not. The wrapped path is now joined up to the blank line that ends it;
// it is only ever compared with the session's own folder, a second heading still gives nothing, and a path that runs into the question gives nothing.
func TestFolderTrustPathJoinsAPathTheTerminalWrapped(t *testing.T) {
	const long = "/private/tmp/claude-501/-Users-cknorowski-Software-coral-coral-go/b49dc594-d472-3e97-0bcc-c26ce11bce2c/scratchpad/readinglist-proj"
	screen := func(folderLines ...string) string {
		return "──────────\n Accessing workspace:\n\n " + strings.Join(folderLines, "\n ") + "\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code)\n\n ❯ No, exit\n   Yes, I trust this folder\n"
	}
	for _, width := range []int{60, 80, 100, 130} {
		var lines []string
		for rest := long; rest != ""; {
			n := width - 1
			if n > len(rest) {
				n = len(rest)
			}
			lines = append(lines, rest[:n])
			rest = rest[n:]
		}
		assert.Equal(t, long, folderTrustPath(screen(lines...)), "wrapped at %d columns (%d lines)", width, len(lines))
	}
	assert.Equal(t, long, folderTrustPath(screen(long)), "one line: as before")
	// a second heading still gives nothing; a path that runs into the question gives nothing
	assert.Equal(t, "", folderTrustPath("Accessing workspace:\n/x\n"+screen(long)))
	assert.Equal(t, "", folderTrustPath(" Accessing workspace:\n Quick safety check: Is this a project you created or one you trust?\n"))
	assert.Equal(t, "", folderTrustPath(" Accessing workspace:\n /a/path\n Quick safety check: Is this a project\n"+" more\n"), "no blank line between the path and the question: the question line is not a path")
	// the folder joined is not the session's own folder unless it is exactly that folder
	assert.False(t, sameFolder(folderTrustPath(screen(long[:60], long[60:])+" extra"), long))
}

// Security's SHOULD 3 on #14560: a deep worktree under a narrow terminal wraps many times. Joined from up to trustPathMaxLines (8) lines: 5 and 8 lines are read whole; a 9-line wrap is a prefix, which is
// never the session's own folder, so it gets no Yes (fail closed).
func TestFolderTrustPathJoinsUpToEightWrappedLinesAndNoMore(t *testing.T) {
	const long = "/private/tmp/claude-501/-Users-cknorowski-Software-coral-coral-go/b49dc594-d472-3e97-0bcc-c26ce11bce2c/scratchpad/readinglist-proj"
	screenOf := func(chunk int) (string, int) {
		var lines []string
		for rest := long; rest != ""; {
			n := chunk
			if n > len(rest) {
				n = len(rest)
			}
			lines = append(lines, rest[:n])
			rest = rest[n:]
		}
		return "──────────\n Accessing workspace:\n\n " + strings.Join(lines, "\n ") + "\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code)\n\n ❯ No, exit\n   Yes, I trust this folder\n", len(lines)
	}
	for _, c := range []struct{ chunk, lines int }{{28, 5}, {17, 8}} {
		screen, n := screenOf(c.chunk)
		require.Equal(t, c.lines, n, "the fixture wraps into %d lines", c.lines)
		assert.Equal(t, long, folderTrustPath(screen), "%d wrapped lines are read whole", c.lines)
	}
	screen, n := screenOf(13)
	require.Equal(t, 10, n)
	got := folderTrustPath(screen)
	assert.NotEqual(t, long, got, "more lines than the cap are read as a prefix")
	assert.False(t, sameFolder(got, long), "and a prefix is never the session's own folder: no Yes")
}
