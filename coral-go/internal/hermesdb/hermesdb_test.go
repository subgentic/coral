package hermesdb

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var (
	idA = "local-" + strings.Repeat("a", 64)
	idB = "local-" + strings.Repeat("b", 64)
)

const fullSchema = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, ended_at REAL, message_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cwd TEXT, title TEXT, last_activity_at REAL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL, finish_reason TEXT, active INTEGER DEFAULT 1);`

// rig is a Hermes home with a state.db in WAL mode whose writer stays open, as a running Hermes keeps it.
type rig struct {
	home   string
	writer *sql.DB
}

func newRig(t *testing.T, schema string) *rig {
	t.Helper()
	home := t.TempDir()
	w, err := sql.Open("sqlite", "file:"+filepath.Join(home, "state.db")+"?_pragma=journal_mode(wal)")
	require.NoError(t, err)
	w.SetMaxOpenConns(1)
	t.Cleanup(func() { w.Close() })
	_, err = w.Exec(schema)
	require.NoError(t, err)
	return &rig{home: home, writer: w}
}

func (r *rig) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	_, err := r.writer.Exec(q, args...)
	require.NoError(t, err)
}

func (r *rig) msg(t *testing.T, session, role, content string, extra ...any) {
	t.Helper()
	r.exec(t, `INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`, session, role, content, 1700000000.5)
}

func open(t *testing.T, home string) *DB {
	t.Helper()
	d, err := Open(home)
	require.NoError(t, err)
	t.Cleanup(func() { d.Close() })
	return d
}

func TestReadsOnlyTheSessionsRowsInOrderWhileTheWriterIsOpen(t *testing.T) {
	r := newRig(t, fullSchema)
	r.exec(t, `INSERT INTO sessions (id, source, model, started_at, cwd, title, last_activity_at, message_count) VALUES (?, 'local', 'm1', 1700000000, '/work', 'T', 1700000009, 3)`, idA)
	r.exec(t, `INSERT INTO sessions (id, source, model, started_at) VALUES (?, 'local', 'm2', 1700000001)`, idB)
	r.msg(t, idA, "user", "one")
	r.msg(t, idB, "user", "OTHER SESSION")
	r.msg(t, idA, "assistant", "two")
	r.exec(t, `INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, timestamp) VALUES (?, 'tool', '{"output":"hi"}', 'terminal', 'call_1', 1700000003)`, idA)

	d := open(t, r.home)
	s, ok, err := d.Session(context.Background(), idA)
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, Session{ID: idA, Model: "m1", CWD: "/work", Title: "T", Source: "local", StartedAt: 1700000000, LastActivity: 1700000009, MessageCount: 3}, s)

	msgs, err := d.Messages(context.Background(), idA, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 3)
	assert.Equal(t, []string{"user", "assistant", "tool"}, []string{msgs[0].Role, msgs[1].Role, msgs[2].Role})
	assert.Equal(t, "terminal", msgs[2].ToolName)
	assert.Equal(t, "call_1", msgs[2].ToolCallID)
	for _, m := range msgs {
		assert.NotContains(t, m.Content, "OTHER")
	}
	// a row written after the first read is read by the next, from its id on
	r.msg(t, idA, "user", "three")
	more, err := d.Messages(context.Background(), idA, msgs[2].ID, 0)
	require.NoError(t, err)
	require.Len(t, more, 1)
	assert.Equal(t, "three", more[0].Content)

	_, ok, err = d.Session(context.Background(), idB[:len(idB)-1]+"c")
	require.NoError(t, err)
	assert.False(t, ok, "a well-formed id that names nothing")
}

// Nothing but a Hermes id reaches the query: an id that is anything else is refused before the database is asked.
func TestOnlyAHermesIDIsAsked(t *testing.T) {
	r := newRig(t, fullSchema)
	r.msg(t, idA, "user", "x")
	d := open(t, r.home)
	for _, id := range []string{"", "latest", "d7b90358", idA + "'", "local-" + strings.Repeat("a", 64) + " OR 1=1", "%", strings.ToUpper(idA), "local-%", idA[:20]} {
		_, err := d.Messages(context.Background(), id, 0, 0)
		assert.ErrorIs(t, err, ErrBadID, id)
		_, _, err = d.Session(context.Background(), id)
		assert.ErrorIs(t, err, ErrBadID, id)
	}
}

func TestInactiveRowsAreLeftOutAndTheNewestAreKept(t *testing.T) {
	r := newRig(t, fullSchema)
	r.msg(t, idA, "user", "old")
	r.exec(t, `INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'assistant', 'dropped', 1700000001, 0)`, idA)
	for i := 0; i < 5; i++ {
		r.msg(t, idA, "user", "m"+string(rune('0'+i)))
	}
	d := open(t, r.home)
	all, err := d.Messages(context.Background(), idA, 0, 0)
	require.NoError(t, err)
	require.Len(t, all, 6)
	for _, m := range all {
		assert.NotEqual(t, "dropped", m.Content)
	}
	last, err := d.Messages(context.Background(), idA, 0, 2)
	require.NoError(t, err)
	require.Len(t, last, 2)
	assert.Equal(t, []string{"m3", "m4"}, []string{last[0].Content, last[1].Content}, "the newest two, oldest first")
}

func TestATextIsCutAtTheCapOnARuneBoundary(t *testing.T) {
	r := newRig(t, fullSchema)
	r.msg(t, idA, "assistant", strings.Repeat("é", MaxText)) // two bytes a rune: twice the cap
	d := open(t, r.home)
	msgs, err := d.Messages(context.Background(), idA, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	assert.LessOrEqual(t, len(msgs[0].Content), MaxText)
	assert.Greater(t, len(msgs[0].Content), MaxText-4)
	assert.True(t, strings.HasSuffix(msgs[0].Content, "é"), "no split rune")
}

// The open is read-only: it creates nothing where there is no database, and a read leaves the file as it was.
func TestOpenIsReadOnlyAndCreatesNothing(t *testing.T) {
	empty := t.TempDir()
	_, err := Open(empty)
	assert.ErrorIs(t, err, ErrNoStore)
	_, err = os.Stat(filepath.Join(empty, "state.db"))
	assert.True(t, os.IsNotExist(err), "no state.db is made")
	_, err = Open(filepath.Join(empty, "nope"))
	assert.ErrorIs(t, err, ErrNoStore)
	_, err = Open("")
	assert.ErrorIs(t, err, ErrNoStore)

	r := newRig(t, fullSchema)
	r.msg(t, idA, "user", "x")
	r.exec(t, `PRAGMA wal_checkpoint(TRUNCATE)`) // not QueryRow(...).Err(): that leaves the rows open, and the one connection of the writer is then never released, so Windows cannot delete state.db at the end (#12266)
	sum := func() [32]byte {
		b, err := os.ReadFile(filepath.Join(r.home, "state.db"))
		require.NoError(t, err)
		return sha256.Sum256(b)
	}
	before := sum()
	d := open(t, r.home)
	_, err = d.Messages(context.Background(), idA, 0, 0)
	require.NoError(t, err)
	assert.Equal(t, before, sum(), "the database file is untouched")
	// a write through the same open is refused by the engine
	_, err = d.db.Exec(`INSERT INTO messages (session_id, role, content) VALUES ('x', 'user', 'y')`)
	assert.Error(t, err)
	_, err = d.db.Exec(`DELETE FROM messages`)
	assert.Error(t, err)
}

func TestAHomeThatIsALinkIsFollowedButAStateDBThatIsALinkIsNot(t *testing.T) {
	r := newRig(t, fullSchema)
	r.msg(t, idA, "user", "x")
	linkHome := filepath.Join(t.TempDir(), "home-link")
	require.NoError(t, os.Symlink(r.home, linkHome))
	got, err := Path(linkHome)
	require.NoError(t, err)
	realHome, err := filepath.EvalSymlinks(r.home)
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(realHome, "state.db"), got, "the path is under the resolved folder")
	d := open(t, linkHome) // HERMES_HOME may be a link: the resolved folder is read
	msgs, err := d.Messages(context.Background(), idA, 0, 0)
	require.NoError(t, err)
	assert.Len(t, msgs, 1)

	// state.db as a link to a database elsewhere (the agent can write in its own home) is refused
	elsewhere := newRig(t, fullSchema)
	home := t.TempDir()
	require.NoError(t, os.Symlink(filepath.Join(elsewhere.home, "state.db"), filepath.Join(home, "state.db")))
	_, err = Open(home)
	assert.ErrorIs(t, err, ErrNotRegular)
	// and a folder named state.db
	home2 := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(home2, "state.db"), 0o700))
	_, err = Open(home2)
	assert.ErrorIs(t, err, ErrNotRegular)
}

func TestALayoutWithoutANeededColumnIsErrSchemaAndOptionalOnesMayBeAbsent(t *testing.T) {
	// a newer Hermes that renamed a column Coral reads
	r := newRig(t, `CREATE TABLE sessions (id TEXT, model TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, body TEXT, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL);`)
	_, err := Open(r.home)
	require.ErrorIs(t, err, ErrSchema)
	assert.Contains(t, err.Error(), "messages.content")
	// no table at all
	r2 := newRig(t, `CREATE TABLE other (x INTEGER);`)
	_, err = Open(r2.home)
	assert.ErrorIs(t, err, ErrSchema)
	// only the needed columns: the optional ones are read as empty
	r3 := newRig(t, `CREATE TABLE sessions (id TEXT, model TEXT, started_at REAL); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL);`)
	r3.exec(t, `INSERT INTO sessions VALUES (?, 'm', 1)`, idA)
	r3.exec(t, `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'hi')`, idA)
	d := open(t, r3.home)
	s, ok, err := d.Session(context.Background(), idA)
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, "m", s.Model)
	assert.Empty(t, s.CWD)
	msgs, err := d.Messages(context.Background(), idA, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	assert.Equal(t, "hi", msgs[0].Content)
	assert.Empty(t, msgs[0].FinishReason)
}

func TestAContextThatIsDoneStopsARead(t *testing.T) {
	r := newRig(t, fullSchema)
	r.msg(t, idA, "user", "x")
	d := open(t, r.home)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := d.Messages(ctx, idA, 0, 0)
	assert.True(t, errors.Is(err, context.Canceled), "%v", err)
}

// The file is one the agent can write: the engine does not trust its schema (a view or trigger it planted must not call a function), and query_only stays on.
func TestTheDatabaseIsOpenedWithAnUntrustedSchema(t *testing.T) {
	r := newRig(t, fullSchema)
	d := open(t, r.home)
	var trusted, queryOnly int
	require.NoError(t, d.db.QueryRow(`PRAGMA trusted_schema`).Scan(&trusted))
	require.NoError(t, d.db.QueryRow(`PRAGMA query_only`).Scan(&queryOnly))
	assert.Equal(t, 0, trusted)
	assert.Equal(t, 1, queryOnly)
}
