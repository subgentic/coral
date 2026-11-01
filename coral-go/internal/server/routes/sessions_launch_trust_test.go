package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #11889: launching a team in a folder counts as trusting it for the agents that ask, under Security's conditions: only the person's own dashboard, only a folder Coral made in this launch or one the person
// ticked, and the reply says what was trusted and what was not.

type trustRig struct {
	h      *SessionsHandler
	home   string
	claude string
	codex  string
	n      int
}

func newTrustRig(t *testing.T) *trustRig {
	t.Helper()
	_, h, _, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	home, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	r := &trustRig{h: h, home: home, claude: filepath.Join(home, ".claude.json"), codex: filepath.Join(home, ".codex", "config.toml")}
	require.NoError(t, os.WriteFile(r.claude, []byte(`{"userID":"abc"}`), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Dir(r.codex), 0o700))
	require.NoError(t, os.WriteFile(r.codex, []byte("model = \"gpt-5\"\n"), 0o600))
	return r
}

func asCaller(kind string) func(*http.Request) *http.Request {
	return func(r *http.Request) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, kind))
	}
}

// launch starts a team of a Claude, a Codex and an agy member in dir (made by the launch when create is true), as caller.
func (r *trustRig) launch(t *testing.T, dir string, create, tick bool, as func(*http.Request) *http.Request) map[string]any {
	t.Helper()
	r.n++
	b, _ := json.Marshal(map[string]any{"board_name": "trust" + string(rune('a'+r.n)), "new_board": true, "working_dir": dir, "create_dir": create, "trust_folder": tick, "agent_type": "claude",
		"agents": []map[string]any{{"name": "A", "agent_type": "claude"}, {"name": "B", "agent_type": "codex"}, {"name": "C", "agent_type": "agy"}}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b))
	r.h.LaunchTeam(rec, as(req))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func (r *trustRig) claudeTrusts(t *testing.T, path string) bool {
	t.Helper()
	b, err := os.ReadFile(r.claude)
	require.NoError(t, err)
	var m struct {
		Projects map[string]map[string]any `json:"projects"`
	}
	require.NoError(t, json.Unmarshal(b, &m))
	return m.Projects[path]["hasTrustDialogAccepted"] == true
}

func (r *trustRig) codexTrusts(t *testing.T, path string) bool {
	t.Helper()
	b, err := os.ReadFile(r.codex)
	require.NoError(t, err)
	return strings.Contains(string(b), "[projects.\""+path+"\"]") && strings.Contains(string(b), "trust_level = \"trusted\"")
}

func trustOf(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	tf, ok := out["trust_folder"].(map[string]any)
	require.True(t, ok, "the reply names what was trusted: %v", out)
	return tf
}

func TestAFolderTheLaunchMadeIsTrustedForTheAgentsThatAsk(t *testing.T) {
	r := newTrustRig(t)
	dir := filepath.Join(r.home, "Coral", "proj")
	out := r.launch(t, dir, true, false, asCaller(callerDashCookie))
	tf := trustOf(t, out)
	assert.Equal(t, dir, tf["path"])
	assert.ElementsMatch(t, []any{"claude", "codex"}, tf["trusted"].([]any))
	assert.Contains(t, tf["not"].(map[string]any), "agy", "an agent type with no setting Coral can set is named")
	assert.True(t, r.claudeTrusts(t, dir))
	assert.True(t, r.codexTrusts(t, dir))
	// the folder is the one the agents started in, and no other entry was made
	b, _ := os.ReadFile(r.claude)
	assert.NotContains(t, string(b), r.home+"\"", "home itself is not an entry")
	// an Operator can see it afterwards: one board message names the folder and the agents
	notices := r.trustNotices(t, out["board"].(string))
	require.Len(t, notices, 1, "%v", notices)
	assert.Contains(t, notices[0], dir)
	assert.Contains(t, notices[0], "claude, codex")
}

// trustNotices are the team's board messages that say a folder was trusted.
func (r *trustRig) trustNotices(t *testing.T, board string) []string {
	t.Helper()
	msgs, err := r.h.bs.ListMessages(context.Background(), board, 100, 0, 0)
	require.NoError(t, err)
	var out []string
	for _, m := range msgs {
		if strings.Contains(m.Content, "trusted") && strings.Contains(m.Content, "Coral") {
			out = append(out, m.Content)
		}
	}
	return out
}

func TestOnlyThePersonsOwnDashboardTrustsAFolder(t *testing.T) {
	for name, as := range map[string]func(*http.Request) *http.Request{
		"an agent": func(req *http.Request) *http.Request {
			return req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "11111111-2222-4333-8444-555555555555", SessionName: "claude-11111111-2222-4333-8444-555555555555"}))
		},
		"the Hub": func(req *http.Request) *http.Request {
			req.Header.Set(tunnel.ViaHeader, "x")
			return asCaller(callerHub)(req)
		},
		"the Hub owner": func(req *http.Request) *http.Request {
			req.Header.Set(tunnel.ViaHeader, "x")
			return asCaller(callerHubOwner)(req)
		},
		"the CLI":   asCaller(callerCLISigned),
		"no caller": func(req *http.Request) *http.Request { return req },
	} {
		t.Run(name, func(t *testing.T) {
			r := newTrustRig(t)
			dir := filepath.Join(r.home, "Coral", "proj")
			out := r.launch(t, dir, true, true, as)
			tf, _ := out["trust_folder"].(map[string]any)
			if tf != nil {
				assert.Empty(t, tf["trusted"], "nothing is trusted")
				assert.NotEmpty(t, tf["refused"], "and it says why")
			}
			assert.False(t, r.claudeTrusts(t, dir))
			assert.False(t, r.codexTrusts(t, dir))
			b, _ := os.ReadFile(r.claude)
			assert.Equal(t, `{"userID":"abc"}`, string(b), "the file is untouched")
			assert.Empty(t, r.trustNotices(t, out["board"].(string)), "and nothing is said on the board")
		})
	}
}

func TestAnExistingFolderIsTrustedOnlyWithTheTickAndNeverHomeOrADirectChild(t *testing.T) {
	r := newTrustRig(t)
	dash := asCaller(callerDashCookie)
	existing := filepath.Join(r.home, "Code", "app")
	require.NoError(t, os.MkdirAll(existing, 0o755))

	out := r.launch(t, existing, false, false, dash)
	assert.Nil(t, out["trust_folder"], "an existing folder with no tick asks nothing of the settings")
	assert.False(t, r.claudeTrusts(t, existing))

	out = r.launch(t, existing, false, true, dash)
	assert.ElementsMatch(t, []any{"claude", "codex"}, trustOf(t, out)["trusted"].([]any))
	assert.True(t, r.claudeTrusts(t, existing))

	child := filepath.Join(r.home, "Documents")
	require.NoError(t, os.MkdirAll(child, 0o755))
	for name, p := range map[string]string{"home": r.home, "a direct child of home": child, "a hidden folder": mustMkdir(t, filepath.Join(r.home, ".claude", "x"))} {
		out = r.launch(t, p, false, true, dash)
		tf := trustOf(t, out)
		assert.Empty(t, tf["trusted"], name)
		assert.NotEmpty(t, tf["refused"], name)
		assert.False(t, r.claudeTrusts(t, p), name)
	}
}

func mustMkdir(t *testing.T, p string) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(p, 0o755))
	return p
}

func TestWhenTheClaudeFileIsNotThereTheCardStaysAndTheReplySaysSo(t *testing.T) {
	r := newTrustRig(t)
	require.NoError(t, os.Remove(r.claude))
	dir := filepath.Join(r.home, "Coral", "proj")
	out := r.launch(t, dir, true, false, asCaller(callerDashCookie))
	tf := trustOf(t, out)
	assert.Equal(t, []any{"codex"}, tf["trusted"])
	assert.Contains(t, tf["not"].(map[string]any), "claude")
	_, err := os.Stat(r.claude)
	assert.True(t, os.IsNotExist(err), "the file is not made")
}

// A team that works in a worktree starts in a folder made from existing code: the folder the launch made does not count for it, and only the person's tick does.
func TestAWorktreeIsTrustedOnlyWithTheTick(t *testing.T) {
	r := newTrustRig(t)
	work := filepath.Join(r.home, "Code", "wt")
	require.NoError(t, os.MkdirAll(work, 0o755))
	body := launchTeamRequest{AgentType: "claude", Agents: []launchTeamAgent{{Name: "A"}}}
	req := asCaller(callerDashCookie)(httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", nil))

	assert.Nil(t, r.h.trustTeamFolder(req, body, work, true, true), "made, but in a worktree: nothing was asked")
	assert.False(t, r.claudeTrusts(t, work))
	body.TrustFolder = true
	got := r.h.trustTeamFolder(req, body, work, true, true)
	assert.Equal(t, []string{"claude"}, got["trusted"])
	assert.True(t, r.claudeTrusts(t, work))
}

// Security's SHOULD (1): the folder's name is text from the disk (it can hold a quote, a line break's look-alike or a bidi mark), so the board message quotes it, with every unprintable character written out.
func TestTheBoardNoticeQuotesTheFolderName(t *testing.T) {
	r := newTrustRig(t)
	dir := filepath.Join(r.home, "Code", "ap\"p\u202egnp.exe")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	out := r.launch(t, dir, false, true, asCaller(callerDashCookie))
	assert.Equal(t, []any{"claude"}, trustOf(t, out)["trusted"], "Codex refuses a name with a quote, Claude does not")
	notices := r.trustNotices(t, out["board"].(string))
	require.Len(t, notices, 1, "%v", notices)
	assert.Contains(t, notices[0], strconv.Quote(dir), "the name is quoted, escapes written out")
	assert.NotContains(t, notices[0], "\u202e", "no bidi mark reaches the message")
}
