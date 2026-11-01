package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"

	_ "modernc.org/sqlite"
)

// #11831: a Hermes agent's chat is the rows of its team's Coral-owned Hermes home, for the Hermes session its hooks bound to the Coral session.

const hermesChatSchema = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, ended_at REAL, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cwd TEXT, title TEXT, last_activity_at REAL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL, finish_reason TEXT, active INTEGER DEFAULT 1);`

// writeHermesState makes <home>/state.db (WAL, its writer left open as a running Hermes keeps it) and returns it for more rows.
func writeHermesState(t *testing.T, home string) *sql.DB {
	t.Helper()
	require.NoError(t, osMkdirAll(home))
	w, err := sql.Open("sqlite", "file:"+filepath.Join(home, "state.db")+"?_pragma=journal_mode(wal)")
	require.NoError(t, err)
	w.SetMaxOpenConns(1)
	t.Cleanup(func() { w.Close() })
	_, err = w.Exec(hermesChatSchema)
	require.NoError(t, err)
	return w
}

func addHermesMsg(t *testing.T, w *sql.DB, session, role, content string) {
	t.Helper()
	_, err := w.Exec(`INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, 1788000000)`, session, role, content)
	require.NoError(t, err)
}

type hermesChatRig struct {
	base      string
	dataDir   string
	sid       string
	hermesID  string
	teamState *sql.DB
}

func newHermesChatRig(t *testing.T) hermesChatRig {
	t.Helper()
	server, handler, _, ss := setupSessionsTestServer(t)
	r := hermesChatRig{
		base: server.URL + "/api/sessions/live/hermes-agent", dataDir: handler.cfg.CoralDir(),
		sid: "00000000-0000-0000-0000-00000000e11a", hermesID: "local-" + strings.Repeat("c3", 32),
	}
	team := "team-a"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: r.sid, AgentType: "hermes", AgentName: "hermes-agent", WorkingDir: "/tmp/test", BoardName: &team}))
	r.teamState = writeHermesState(t, agent.HermesTeamHome(r.dataDir, team))
	return r
}

func (r hermesChatRig) chat(t *testing.T) (msgs []any, total float64) {
	t.Helper()
	out := chatReply(t, r.base, url.Values{"session_id": {r.sid}, "agent_type": {"hermes"}, "limit": {"50"}})
	msgs, _ = out["messages"].([]any)
	total, _ = out["total"].(float64)
	return msgs, total
}

func TestHermesChatReadsTheLinkedSessionOfTheTeamsHome(t *testing.T) {
	r := newHermesChatRig(t)
	addHermesMsg(t, r.teamState, r.hermesID, "user", "hello from the person")
	addHermesMsg(t, r.teamState, r.hermesID, "assistant", "hi, here is the answer")
	addHermesMsg(t, r.teamState, "local-"+strings.Repeat("dd", 32), "user", "ANOTHER SESSION")

	_, total := r.chat(t)
	assert.Zero(t, total, "no link yet: no rows")

	require.NoError(t, transcriptlink.BindHermes(r.dataDir, r.sid, r.hermesID))
	msgs, total := r.chat(t)
	require.EqualValues(t, 2, total)
	require.Len(t, msgs, 2)
	all := strings.Join([]string{hermesJSON(t, msgs)}, "")
	assert.Contains(t, all, "hello from the person")
	assert.NotContains(t, all, "ANOTHER SESSION")
	assert.Contains(t, all, "hi, here is the answer")

	// a row written later shows on the next poll
	addHermesMsg(t, r.teamState, r.hermesID, "user", "and then this")
	_, total = r.chat(t)
	assert.EqualValues(t, 3, total)
}

// Another team's home is never read: the session's team decides the home, so the same Hermes id in a different team's state.db shows nothing.
func TestHermesChatNeverReadsAnotherTeamsHome(t *testing.T) {
	r := newHermesChatRig(t)
	other := writeHermesState(t, agent.HermesTeamHome(r.dataDir, "team-b"))
	addHermesMsg(t, other, r.hermesID, "user", "TEAM B SECRET")
	require.NoError(t, transcriptlink.BindHermes(r.dataDir, r.sid, r.hermesID))
	msgs, total := r.chat(t)
	assert.Zero(t, total, "%v", msgs)
}

func TestHermesChatWithNoStateDBOrABrokenOneIsEmptyNotAnError(t *testing.T) {
	server, handler, _, ss := setupSessionsTestServer(t)
	sid := "00000000-0000-0000-0000-00000000e11b"
	team := "team-a"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "hermes-b", WorkingDir: "/tmp/test", BoardName: &team}))
	hid := "local-" + strings.Repeat("c4", 32)
	require.NoError(t, transcriptlink.BindHermes(handler.cfg.CoralDir(), sid, hid))
	out := chatReply(t, server.URL+"/api/sessions/live/hermes-b", url.Values{"session_id": {sid}, "agent_type": {"hermes"}})
	assert.EqualValues(t, 0, out["total"], "no state.db yet")
	// a layout Coral does not read
	home := agent.HermesTeamHome(handler.cfg.CoralDir(), team)
	w := writeHermesStateWith(t, home, `CREATE TABLE other (x INTEGER);`)
	_ = w
	out = chatReply(t, server.URL+"/api/sessions/live/hermes-b", url.Values{"session_id": {sid}, "agent_type": {"hermes"}})
	assert.EqualValues(t, 0, out["total"])
}

func osMkdirAll(p string) error { return os.MkdirAll(p, 0o700) }

func hermesJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

func writeHermesStateWith(t *testing.T, home, schema string) *sql.DB {
	t.Helper()
	require.NoError(t, osMkdirAll(home))
	w, err := sql.Open("sqlite", "file:"+filepath.Join(home, "state.db")+"?_pragma=journal_mode(wal)")
	require.NoError(t, err)
	t.Cleanup(func() { w.Close() })
	_, err = w.Exec(schema)
	require.NoError(t, err)
	return w
}
