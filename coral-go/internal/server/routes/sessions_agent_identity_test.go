package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
)

// #7565: a bounded caller (the Hub, and anyone who is not the local dashboard) reads the folder of the session its session_id names, for the agent called {name}, or gets 404: no id, an unknown id, a stale
// id (an ended session whose last folder is still in the git snapshots, under a name another agent now has) and another agent's id are all refused; the name is never a fallback.
func TestFileAndDiffReadsNeedTheSessionOfTheAgentNamed(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	mk := func(file, text string) string {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, file), []byte(text), 0o644))
		for _, args := range [][]string{{"init", "-q"}, {"add", "."}, {"-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x"}} {
			cmd := consoletest.HiddenCommand("git", append([]string{"-C", dir}, args...)...)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Skipf("git is not usable here: %v %s", err, out)
			}
		}
		require.NoError(t, os.WriteFile(filepath.Join(dir, file), []byte(text+"changed\n"), 0o644)) // a change for the diff
		return dir
	}
	dirA, dirB, dirStale := mk("a.txt", "agent a\n"), mk("b.txt", "agent b\n"), mk("old.txt", "an ended agent\n")
	const sidA, sidB, sidStale, sidUnknown = "00000000-0000-0000-0000-0000000075a1", "00000000-0000-0000-0000-0000000075b1", "00000000-0000-0000-0000-0000000075c1", "00000000-0000-0000-0000-0000000075d1"
	for _, a := range []struct{ name, sid, dir string }{{"agent-a", sidA, dirA}, {"agent-b", sidB, dirB}} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: a.sid, AgentType: "claude", AgentName: a.name, WorkingDir: a.dir}))
		terminal.addSession("claude-"+a.sid, a.dir)
	}
	// The name fallback of old: agent-a's last git state, and an ended session's (its row is gone) under the name agent-a again.
	require.NoError(t, h.gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: "agent-a", AgentType: "claude", WorkingDirectory: dirA}))
	stale := sidStale
	require.NoError(t, h.gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: "agent-a", AgentType: "claude", WorkingDirectory: dirStale, SessionID: &stale}))

	// A fresh cache of the changed files under the NAME, and under the ended session: a bounded caller with no id must not be answered from them.
	cached := []store.ChangedFile{{Filepath: "a.txt", Status: "M"}}
	require.NoError(t, h.gs.ReplaceChangedFiles(ctx, "agent-a", dirA, cached, nil, "branch_point"))
	require.NoError(t, h.gs.ReplaceChangedFiles(ctx, "agent-a", dirStale, []store.ChangedFile{{Filepath: "old.txt", Status: "M"}}, &stale, "branch_point"))

	r := chi.NewRouter()
	r.Get("/api/sessions/live/{name}/git", h.Git)
	r.Post("/api/sessions/live/{name}/open-in-editor", h.OpenInEditor)
	r.Get("/api/sessions/live/{name}/file-content", h.GetFileContent)
	r.Get("/api/sessions/live/{name}/file-original", h.GetFileOriginal)
	r.Get("/api/sessions/live/{name}/diff", h.Diff)
	r.Get("/api/sessions/live/{name}/changes.diff", h.ChangesDiff)
	r.Get("/api/sessions/live/{name}/files", h.Files)
	r.Post("/api/sessions/live/{name}/files/refresh", h.RefreshFiles)
	r.Get("/api/sessions/live/{name}/search-files", h.SearchFiles)
	r.Get("/api/sessions/live/{name}/resolve-path", h.ResolvePath)
	r.Put("/api/sessions/live/{name}/file-content", h.SaveFileContent)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	type call struct{ method, route, query, body string }
	handlers := map[string]func(sid string) call{
		"file-content":  func(sid string) call { return call{http.MethodGet, "file-content", "filepath=a.txt" + sidQ(sid), ""} },
		"file-original": func(sid string) call { return call{http.MethodGet, "file-original", "filepath=a.txt" + sidQ(sid), ""} },
		"diff":          func(sid string) call { return call{http.MethodGet, "diff", strings.TrimPrefix(sidQ(sid), "&"), ""} },
		"changes.diff": func(sid string) call {
			return call{http.MethodGet, "changes.diff", strings.TrimPrefix(sidQ(sid), "&"), ""}
		},
		"files": func(sid string) call { return call{http.MethodGet, "files", strings.TrimPrefix(sidQ(sid), "&"), ""} },
		"files/refresh": func(sid string) call {
			return call{http.MethodPost, "files/refresh", "", `{"session_id":"` + sid + `"}`}
		},
		"search-files": func(sid string) call { return call{http.MethodGet, "search-files", "q=a" + sidQ(sid), ""} },
		"git":          func(sid string) call { return call{http.MethodGet, "git", strings.TrimPrefix(sidQ(sid), "&"), ""} },
		"open-in-editor": func(sid string) call {
			return call{http.MethodPost, "open-in-editor", "", `{"filepath":"a.txt","editor":"none-such","session_id":"` + sid + `"}`}
		},
		"explorer":     func(sid string) call { return call{http.MethodGet, "search-files", "view=explorer" + sidQ(sid), ""} },
		"resolve-path": func(sid string) call { return call{http.MethodGet, "resolve-path", "filepath=a.txt" + sidQ(sid), ""} },
		"save": func(sid string) call {
			return call{http.MethodPut, "file-content", "filepath=saved.txt" + sidQ(sid), `{"content":"x"}`}
		},
	}
	do := func(name string, c call) (int, string) {
		u := server.URL + "/api/sessions/live/" + url.PathEscape(name) + "/" + c.route
		if c.query != "" {
			u += "?" + c.query
		}
		req, err := http.NewRequest(c.method, u, strings.NewReader(c.body))
		require.NoError(t, err)
		if c.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	for label, mkCall := range handlers {
		for _, tc := range []struct {
			what, name, sid string
			refused         bool
		}{
			{"no session id", "agent-a", "", true},
			{"an unknown id", "agent-a", sidUnknown, true},
			{"a stale id (ended; its last folder is in the snapshots)", "agent-a", sidStale, true},
			{"another agent's id under this name", "agent-a", sidB, true},
			{"the terminal session name with the wrong id", "claude-" + sidB, sidA, true},
			{"the matching id", "agent-a", sidA, false},
			{"the matching id, named by its terminal session name", "claude-" + sidA, sidA, false},
		} {
			status, body := do(tc.name, mkCall(tc.sid))
			if tc.refused {
				assert.Equal(t, http.StatusNotFound, status, "%s, %s: %s", label, tc.what, body)
				assert.Contains(t, body, "live session not found", "%s, %s", label, tc.what)
				assert.NotContains(t, body, "agent b", "%s, %s: another agent's folder is never shown", label, tc.what)
			} else {
				assert.NotContains(t, body, "live session not found", "%s, %s: the session is the agent's own", label, tc.what)
			}
		}
	}

	// The matching id still reads the agent's own folder, and the stale id's folder is not what a bounded caller sees under the name.
	status, body := do("agent-a", call{http.MethodGet, "file-content", "filepath=a.txt&session_id=" + sidA, ""})
	assert.Equal(t, http.StatusOK, status)
	assert.Contains(t, body, "agent a")
	// The folder roots a tunnel request may read inside are the session's own as well.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	own := h.sessionFileRoots(req, "agent-a", sidA)
	require.NotEmpty(t, own)
	for _, root := range own {
		assert.Equal(t, realPath(dirA), root)
	}
	assert.Empty(t, h.sessionFileRoots(req, "agent-a", ""), "no id: no roots, not the name's folder")
	assert.Empty(t, h.sessionFileRoots(req, "agent-a", sidStale), "a stale id: no roots")
	assert.Empty(t, h.sessionFileRoots(req, "agent-a", sidB), "another agent's id under this name: no roots")
}

func sidQ(sid string) string {
	if sid == "" {
		return ""
	}
	return "&session_id=" + sid
}
