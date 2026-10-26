package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agentmemory"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #7454 (the design of #7452, Security's rules): an agent's instruction and memory files. The list issues opaque ids; the read takes only such an id; no path from the client; symlinks and traversal give
// nothing; ids belong to one session and expire.
type memRig struct {
	h        *SessionsHandler
	r        chi.Router
	home     string
	proj     string
	sid      string
	otherSid string
}

func newMemRig(t *testing.T) *memRig {
	t.Helper()
	_, h, _, ss := setupSessionsTestServer(t)
	base, err := safefs.Resolve(t.TempDir())
	require.NoError(t, err)
	home := filepath.Join(base, "home")
	proj := filepath.Join(home, "repo", "app")
	require.NoError(t, os.MkdirAll(proj, 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(home, "repo", ".git"), 0o755))
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	rig := &memRig{h: h, home: home, proj: proj, sid: "aaaaaaaa-7454-4000-8000-000000000001", otherSid: "bbbbbbbb-7454-4000-8000-000000000002"}
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: rig.sid, AgentType: "claude", AgentName: "alpha", WorkingDir: proj}))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: rig.otherSid, AgentType: "claude", AgentName: "beta", WorkingDir: proj}))
	rig.r = chi.NewRouter()
	rig.r.Get("/api/sessions/live/{name}/memory", h.ListMemory)
	rig.r.Get("/api/sessions/live/{name}/memory/{id}", h.ReadMemory)
	return rig
}

func (m *memRig) get(t *testing.T, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	m.r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (m *memRig) list(t *testing.T, sid string) []map[string]any {
	t.Helper()
	code, out := m.get(t, "/api/sessions/live/alpha/memory?session_id="+sid)
	require.Equal(t, http.StatusOK, code, "%v", out)
	var rows []map[string]any
	for _, f := range out["files"].([]any) {
		rows = append(rows, f.(map[string]any))
	}
	return rows
}

func writeMem(t *testing.T, path, text string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(text), 0o644))
}

func TestMemoryListIssuesOpaqueIdsAndReadReturnsThatFileAsText(t *testing.T) {
	m := newMemRig(t)
	writeMem(t, filepath.Join(m.proj, "CLAUDE.md"), "# Project rules\nbe brief\n")
	writeMem(t, filepath.Join(m.home, ".claude", "CLAUDE.md"), "user level")
	mem := filepath.Join(m.home, ".claude", "projects", transcriptlink.ClaudeProjectDirName(m.proj), "memory")
	writeMem(t, filepath.Join(mem, "MEMORY.md"), "- [a](a.md)")

	rows := m.list(t, m.sid)
	require.Len(t, rows, 3)
	assert.Equal(t, "CLAUDE.md", rows[0]["file"])
	assert.Equal(t, "instructions", rows[0]["kind"])
	assert.Equal(t, "project", rows[0]["level"])
	assert.Equal(t, filepath.Join("~", "repo", "app"), rows[0]["where"])
	assert.Equal(t, "user", rows[1]["level"])
	assert.Equal(t, "memory", rows[2]["kind"])
	for _, r := range rows {
		assert.Regexp(t, `^[0-9a-f]{32}$`, r["id"], "an opaque id")
		assert.NotContains(t, r, "path", "no path in a row")
		assert.NotContains(t, r, "dir")
		assert.NotEmpty(t, r["modified"])
	}
	code, got := m.get(t, "/api/sessions/live/alpha/memory/"+rows[0]["id"].(string)+"?session_id="+m.sid)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "# Project rules\nbe brief\n", got["text"])
	assert.Equal(t, false, got["truncated"])
	assert.Equal(t, false, got["binary"])
	assert.NotContains(t, got, "problem")
	assert.NotContains(t, mustJSON(t, got), m.home, "the page is never told a real path (home is ~)")
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

func TestMemoryReadRefusesAnythingButAnIdThisSessionWasIssued(t *testing.T) {
	m := newMemRig(t)
	writeMem(t, filepath.Join(m.proj, "CLAUDE.md"), "mine")
	secret := filepath.Join(m.home, "secret.txt")
	writeMem(t, secret, "SECRET")
	id := m.list(t, m.sid)[0]["id"].(string)

	for name, path := range map[string]string{
		"a path":                  "/api/sessions/live/alpha/memory/" + secret + "?session_id=" + m.sid,
		"a relative path":         "/api/sessions/live/alpha/memory/..%2F..%2Fsecret.txt?session_id=" + m.sid,
		"a dotted name":           "/api/sessions/live/alpha/memory/CLAUDE.md?session_id=" + m.sid,
		"an unissued id":          "/api/sessions/live/alpha/memory/" + strings.Repeat("0", 32) + "?session_id=" + m.sid,
		"an upper-case id":        "/api/sessions/live/alpha/memory/" + strings.ToUpper(id) + "?session_id=" + m.sid,
		"a short id":              "/api/sessions/live/alpha/memory/" + id[:31] + "?session_id=" + m.sid,
		"another session's agent": "/api/sessions/live/alpha/memory/" + id + "?session_id=" + m.otherSid,
	} {
		code, out := m.get(t, path)
		assert.Equal(t, http.StatusNotFound, code, name)
		assert.NotContains(t, mustJSON(t, out), "SECRET", name)
	}
	code, _ := m.get(t, "/api/sessions/live/alpha/memory/"+id)
	assert.Equal(t, http.StatusBadRequest, code, "no session_id")
	code, _ = m.get(t, "/api/sessions/live/alpha/memory?session_id=nope")
	assert.Equal(t, http.StatusNotFound, code, "an unknown agent")
	code, _ = m.get(t, "/api/sessions/live/alpha/memory")
	assert.Equal(t, http.StatusBadRequest, code)
}

func TestMemoryIDsExpireAndAreBounded(t *testing.T) {
	m := newMemRig(t)
	writeMem(t, filepath.Join(m.proj, "CLAUDE.md"), "mine")
	now := time.Now()
	m.h.memoryIDs.now = func() time.Time { return now }
	id := m.list(t, m.sid)[0]["id"].(string)
	code, _ := m.get(t, "/api/sessions/live/alpha/memory/"+id+"?session_id="+m.sid)
	assert.Equal(t, http.StatusOK, code)
	now = now.Add(memoryIDTTL + time.Minute)
	code, _ = m.get(t, "/api/sessions/live/alpha/memory/"+id+"?session_id="+m.sid)
	assert.Equal(t, http.StatusNotFound, code, "an hour later the id is forgotten")

	var first string
	for i := 0; i <= memoryIDMax; i++ {
		got := m.h.memoryIDs.issue(m.sid, agentmemory.File{})
		if i == 0 {
			first = got
		}
	}
	_, ok := m.h.memoryIDs.lookup(m.sid, first)
	assert.False(t, ok, "the oldest is dropped when the table is full")
	assert.LessOrEqual(t, len(m.h.memoryIDs.m), memoryIDMax)
}

func TestMemorySymlinksAndLargeAndBinaryAndGoneFilesAreSaidInWords(t *testing.T) {
	m := newMemRig(t)
	secret := filepath.Join(m.home, "secret.txt")
	writeMem(t, secret, "SECRET")
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Symlink(secret, filepath.Join(m.proj, "CLAUDE.md")))
		rows := m.list(t, m.sid)
		require.Len(t, rows, 1)
		assert.Equal(t, "link", rows[0]["problem"], "listed, with its problem")
		code, out := m.get(t, "/api/sessions/live/alpha/memory/"+rows[0]["id"].(string)+"?session_id="+m.sid)
		assert.Equal(t, http.StatusOK, code)
		assert.Equal(t, "link", out["problem"])
		assert.NotContains(t, out, "text")
		assert.NotContains(t, mustJSON(t, out), "SECRET")
		require.NoError(t, os.Remove(filepath.Join(m.proj, "CLAUDE.md")))
	}
	writeMem(t, filepath.Join(m.proj, "CLAUDE.md"), strings.Repeat("x", agentmemory.MaxRead+50))
	id := m.list(t, m.sid)[0]["id"].(string)
	_, out := m.get(t, "/api/sessions/live/alpha/memory/"+id+"?session_id="+m.sid)
	assert.Equal(t, true, out["truncated"])
	assert.Len(t, out["text"], agentmemory.MaxRead)
	assert.EqualValues(t, agentmemory.MaxRead+50, out["size"])

	writeMem(t, filepath.Join(m.proj, "CLAUDE.md"), "a\x00b")
	_, out = m.get(t, "/api/sessions/live/alpha/memory/"+id+"?session_id="+m.sid)
	assert.Equal(t, true, out["binary"])
	assert.Equal(t, "", out["text"])

	require.NoError(t, os.Remove(filepath.Join(m.proj, "CLAUDE.md")))
	code, _ := m.get(t, "/api/sessions/live/alpha/memory/"+id+"?session_id="+m.sid)
	assert.Equal(t, http.StatusNotFound, code, "a file that went away")
	assert.Empty(t, m.list(t, m.sid), "and the list no longer has it")
}

func TestMemoryOfAnAgentWithNoFilesIsAnEmptyList(t *testing.T) {
	m := newMemRig(t)
	code, out := m.get(t, "/api/sessions/live/alpha/memory?session_id="+m.sid)
	assert.Equal(t, http.StatusOK, code)
	assert.JSONEq(t, `{"files":[]}`, mustJSON(t, out))
}

func TestMemoryFollowsALinkInTheSameFolderAndSaysSo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	m := newMemRig(t)
	writeMem(t, filepath.Join(m.proj, "CLAUDE.md"), "the real text")
	require.NoError(t, os.Symlink("CLAUDE.md", filepath.Join(m.proj, "CLAUDE.local.md")))
	rows := m.list(t, m.sid)
	require.Len(t, rows, 2)
	assert.Equal(t, "CLAUDE.local.md", rows[1]["file"])
	assert.Equal(t, "CLAUDE.md", rows[1]["link_to"])
	assert.NotContains(t, rows[1], "problem")
	assert.NotContains(t, rows[0], "link_to")
	code, out := m.get(t, "/api/sessions/live/alpha/memory/"+rows[1]["id"].(string)+"?session_id="+m.sid)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "the real text", out["text"])
	assert.Equal(t, "CLAUDE.md", out["link_to"])
}

// Security's SHOULD on #7454: a link planted in a cloned repository must not make the Operator read a secret: only a name the CLI itself reads is a followed target.
func TestMemoryDoesNotFollowALinkToASecret(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	m := newMemRig(t)
	writeMem(t, filepath.Join(m.proj, ".env"), "API_KEY=SECRETVALUE")
	writeMem(t, filepath.Join(m.proj, ".git", "config"), "[remote] url = https://user:SECRETVALUE@example.invalid/x.git")
	require.NoError(t, os.Symlink(".env", filepath.Join(m.proj, "CLAUDE.md")))
	require.NoError(t, os.Symlink(filepath.Join(".git", "config"), filepath.Join(m.proj, "CLAUDE.local.md")))
	rows := m.list(t, m.sid)
	require.Len(t, rows, 2)
	for _, r := range rows {
		assert.Equal(t, "link", r["problem"], "%v", r["file"])
		assert.NotContains(t, r, "link_to")
		code, out := m.get(t, "/api/sessions/live/alpha/memory/"+r["id"].(string)+"?session_id="+m.sid)
		assert.Equal(t, http.StatusOK, code)
		assert.NotContains(t, mustJSON(t, out), "SECRETVALUE")
		assert.NotContains(t, out, "text")
	}
}
