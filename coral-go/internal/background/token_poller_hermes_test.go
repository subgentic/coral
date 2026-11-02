package background

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #12041 (goal #192 slice E): a Hermes agent's tokens are the totals its session row in its own state.db keeps (input_tokens, output_tokens, which Hermes adds to as it goes). The poller records the growth
// since what is already recorded for the session as one row, so a poll that sees nothing new records nothing, a server restart records nothing twice, and a cost is derived from the model as for the others.
func TestPollHermesSessionRecordsTheGrowthOfItsSessionTotals(t *testing.T) {
	dbase := setupTestDB(t)
	const sid = "00000000-0000-4000-8000-000000012041"
	hermesID := "local-" + strings.Repeat("e1", 32)
	dir := t.TempDir()
	ss, ls := registerForPoll(t, dbase, sid, "hermes")
	usage := store.NewTokenUsageStore(dbase)
	poller := NewTokenPoller(ss, usage, time.Hour)
	poller.SetHermesDataDir(dir)

	home := agent.HermesAgentHome(dir, "", sid)
	require.NoError(t, os.MkdirAll(home, 0o700))
	w, err := sql.Open("sqlite", "file:"+filepath.Join(home, "state.db")+"?_pragma=journal_mode(wal)")
	require.NoError(t, err)
	w.SetMaxOpenConns(1)
	t.Cleanup(func() { w.Close() })
	_, err = w.Exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, ended_at REAL, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cwd TEXT, title TEXT, last_activity_at REAL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL, finish_reason TEXT, active INTEGER DEFAULT 1);`)
	require.NoError(t, err)
	total := func() (in, out int) {
		u, err := usage.GetSessionUsage(context.Background(), sid)
		require.NoError(t, err)
		if u == nil {
			return 0, 0
		}
		return u.InputTokens, u.OutputTokens
	}

	poller.pollHermesSession(context.Background(), ls)
	in, out := total()
	assert.Zero(t, in+out, "not linked yet: nothing is guessed")

	require.NoError(t, transcriptlink.BindHermes(dir, sid, hermesID))
	poller.pollHermesSession(context.Background(), ls)
	in, out = total()
	assert.Zero(t, in+out, "linked, but no session row yet")

	_, err = w.Exec(`INSERT INTO sessions (id, model, started_at, input_tokens, output_tokens) VALUES (?, 'provider/some-model', 1788000000, 1000, 200)`, hermesID)
	require.NoError(t, err)
	poller.pollHermesSession(context.Background(), ls)
	in, out = total()
	assert.Equal(t, []int{1000, 200}, []int{in, out})

	poller.pollHermesSession(context.Background(), ls)
	in, out = total()
	assert.Equal(t, []int{1000, 200}, []int{in, out}, "nothing new: nothing recorded twice")

	_, err = w.Exec(`UPDATE sessions SET input_tokens = 1500, output_tokens = 260 WHERE id = ?`, hermesID)
	require.NoError(t, err)
	poller.pollHermesSession(context.Background(), ls)
	in, out = total()
	assert.Equal(t, []int{1500, 260}, []int{in, out}, "the growth is the new row")

	// A poller that starts anew (a server restart) reads the same totals and records nothing again.
	again := NewTokenPoller(ss, usage, time.Hour)
	again.SetHermesDataDir(dir)
	again.pollHermesSession(context.Background(), ls)
	in, out = total()
	assert.Equal(t, []int{1500, 260}, []int{in, out}, "a restart does not count the session twice")

	var models []string
	require.NoError(t, dbase.Reader().SelectContext(context.Background(), &models, `SELECT COALESCE(model, '') FROM token_usage_all WHERE session_id = ? AND agent_type = 'hermes' ORDER BY id`, sid))
	assert.Equal(t, []string{"some-model", "some-model"}, models, "one row per poll that saw growth, under the id alone (no provider prefix)")

	// Totals that went down (a session id Hermes started over) record nothing negative.
	_, err = w.Exec(`UPDATE sessions SET input_tokens = 10, output_tokens = 1 WHERE id = ?`, hermesID)
	require.NoError(t, err)
	again.pollHermesSession(context.Background(), ls)
	in, out = total()
	assert.Equal(t, []int{1500, 260}, []int{in, out})
}

// #12314 (Security's SHOULD on #12041): the model a Hermes poll is recorded under passes the SAME allow-list the model chip uses (letters, digits and ._-:/@+, at most 120): the column is Hermes's own text, and an
// agent that writes its own state.db must not put odd text in a usage row. A value outside it records as empty.
func TestHermesRecordModelUsesTheChipsAllowList(t *testing.T) {
	for in, want := range map[string]string{
		"provider/vendor-model-1.2:tag@x+y": "vendor-model-1.2:tag@x+y",
		"vendor-model":                      "vendor-model",
		"  vendor-model  ":                  "vendor-model",
		"":                                  "",
	} {
		assert.Equal(t, want, hermesRecordModel(in), in)
	}
	for name, bad := range map[string]string{
		"a space inside":              "two words",
		"markup":                      "<b>gpt</b>",
		"a quote":                     `gpt"4`,
		"a zero-width character":      "vendor\u200bmodel",
		"a bidirectional override":    "vendor\u202emodel",
		"an escape sequence":          "vendor\x1b[31mmodel",
		"a newline":                   "vendor\nmodel",
		"printable but outside":       "vendor model; drop table",
		"non-ASCII letters":           "modèle-é",
		"a backslash":                 `vendor\model`,
		"over 120 bytes":              strings.Repeat("x", 121),
		"a provider with odd text":    "pro vider/vendor-model",
		"a vendor part with odd text": "provider/vendor model",
	} {
		assert.Empty(t, hermesRecordModel(bad), name)
	}
	assert.Equal(t, strings.Repeat("x", 120), hermesRecordModel(strings.Repeat("x", 120)), "exactly the cap is a model")
}
