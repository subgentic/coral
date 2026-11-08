package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sqlite "modernc.org/sqlite"
)

// #14130: when an agent first read the board message that delivered a comment to it is kept on the ask (read_at), for that agent only, the first time only; the thread shows the earlier of it and seen_at.

func askOf(t *testing.T, s *SessionStore, comment int64, session string) ArtifactAsk {
	t.Helper()
	asks, err := s.ListArtifactAsks(context.Background(), artA)
	require.NoError(t, err)
	for _, a := range asks {
		if a.CommentID == comment && a.AgentSession == session {
			return a
		}
	}
	t.Fatalf("no ask for comment %d and %s", comment, session)
	return ArtifactAsk{}
}

func TestAnAgentsReadOfItsDeliveringMessageStampsItsAskOnceAndNobodyElses(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	for _, sess := range []string{"sess-dev", "sess-qa"} {
		_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", sess, sess, t0)
		require.NoError(t, err)
	}
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 101, 1, "sess-dev"))
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 102, 1, "sess-qa"))
	assert.Equal(t, "", askOf(t, s, 1, "sess-dev").ReadStamp(), "nothing read yet")

	// QA reads the message that was for Dev (a reader of everything does): no stamp for anyone
	n, err := s.MarkCommentMessagesRead(ctx, "team-a", "sess-qa", []int64{101}, t0.Add(time.Minute))
	require.NoError(t, err)
	assert.Zero(t, n, "a message for another agent stamps nothing")
	assert.Equal(t, "", askOf(t, s, 1, "sess-dev").ReadStamp())
	assert.Equal(t, "", askOf(t, s, 1, "sess-qa").ReadStamp())

	// Dev reads its own message (and an unrelated one): Dev's ask is stamped
	n, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{7, 101}, t0.Add(2*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	first := askOf(t, s, 1, "sess-dev").ReadStamp()
	assert.Equal(t, t0.Add(2*time.Minute).UTC().Format(ISOFormat), first)
	assert.Equal(t, "", askOf(t, s, 1, "sess-qa").ReadStamp(), "QA's ask is untouched")

	// the first read wins
	n, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{101}, t0.Add(10*time.Minute))
	require.NoError(t, err)
	assert.Zero(t, n)
	assert.Equal(t, first, askOf(t, s, 1, "sess-dev").ReadStamp(), "a later read moves nothing")

	// another board's message of the same id is not this one
	n, _ = s.MarkCommentMessagesRead(ctx, "team-b", "sess-qa", []int64{102}, t0.Add(11*time.Minute))
	assert.Zero(t, n, "the link is per board")
	assert.Equal(t, "", askOf(t, s, 1, "sess-qa").ReadStamp())
}

func TestTheReadStampIsTheEarlierOfTheCommentsGetAndTheBoardRead(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 101, 1, "sess-dev"))

	// the comments GET came first (seen_at), the board read later: the earlier one is shown
	require.NoError(t, s.MarkAsksSeen(ctx, artA, "sess-dev", t0.Add(time.Minute)))
	_, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{101}, t0.Add(5*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, t0.Add(time.Minute).UTC().Format(ISOFormat), askOf(t, s, 1, "sess-dev").ReadStamp())

	// and the other way round
	_, _, err = s.CreateArtifactAsk(ctx, 2, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 102, 2, "sess-dev"))
	_, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{102}, t0.Add(2*time.Minute))
	require.NoError(t, err)
	require.NoError(t, s.MarkAsksSeen(ctx, artA, "sess-dev", t0.Add(9*time.Minute)))
	assert.Equal(t, t0.Add(2*time.Minute).UTC().Format(ISOFormat), askOf(t, s, 2, "sess-dev").ReadStamp(), "the board read was first")
}

// An ask that ended and is asked again starts anew: the old read does not carry over.
func TestAnAskedAgainThreadStartsUnread(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	_, _, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 101, 1, "sess-dev"))
	_, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{101}, t0.Add(time.Minute))
	require.NoError(t, err)
	require.NotEmpty(t, askOf(t, s, 1, "sess-dev").ReadStamp())
	again, created, err := s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-dev", "Dev", t0.Add(AskTTL+time.Second))
	require.NoError(t, err)
	require.True(t, created)
	assert.Equal(t, "", again.ReadStamp(), "a new ask is unread")
}

// readStampExecs counts the statements the store's WRITER executes (a write goes through ExecContext), so a test can pin how many writes one coral-board read costs (#14130, Security's SHOULD: it is the busiest
// call there is).
type readStampDriver struct{ n *atomic.Int64 }

type readStampConn struct {
	driver.Conn
	n *atomic.Int64
}

func (d readStampDriver) Open(name string) (driver.Conn, error) {
	c, err := (&sqlite.Driver{}).Open(name)
	if err != nil {
		return nil, err
	}
	return readStampConn{c, d.n}, nil
}

func (c readStampConn) ExecContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	c.n.Add(1)
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, q, args)
}

var (
	readStampOnce  sync.Once
	readStampExecs atomic.Int64
)

// countWrites points s's writer at a counting connection to the same database file and returns the counter.
func countWrites(t *testing.T, s *SessionStore) *atomic.Int64 {
	t.Helper()
	var path string
	var seq int
	var name string
	rows, err := s.db.DB.QueryContext(context.Background(), `PRAGMA database_list`)
	require.NoError(t, err)
	for rows.Next() {
		var file string
		require.NoError(t, rows.Scan(&seq, &name, &file))
		if name == "main" {
			path = file
		}
	}
	require.NoError(t, rows.Close())
	require.NotEmpty(t, path)
	readStampOnce.Do(func() { sql.Register("sqlite-read-stamp-counting", readStampDriver{&readStampExecs}) })
	db, err := sql.Open("sqlite-read-stamp-counting", path)
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	orig := s.db.DB
	t.Cleanup(func() { orig.Close() }) // the replaced writer is closed too, or Windows cannot remove the test's folder
	s.db.DB = sqlx.NewDb(db, "sqlite")
	readStampExecs.Store(0)
	return &readStampExecs
}

// A read on a board that never delivered a comment to this agent does no write at all, and a read that stamps is one UPDATE per chunk of 500 message ids, never one per message.
func TestACommentReadStampCostsNoWriteWithoutLinksAndOneUpdatePerChunk(t *testing.T) {
	ctx := context.Background()
	s := newCommentStore(t)
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	execs := countWrites(t, s)
	ids := make([]int64, 1200)
	for i := range ids {
		ids[i] = int64(i + 1)
	}

	n, err := s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", ids, t0)
	require.NoError(t, err)
	assert.Zero(t, n)
	assert.Zero(t, execs.Load(), "a board with no comment-message links: no write for 1200 messages")

	_, _, err = s.CreateArtifactAsk(ctx, 1, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 777, 1, "sess-dev"))
	execs.Store(0)
	n, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", []int64{3, 777}, t0)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	assert.Equal(t, int64(1), execs.Load(), "a read of a few messages is one UPDATE")

	execs.Store(0)
	_, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", ids, t0.Add(time.Minute))
	require.NoError(t, err)
	assert.Equal(t, int64(3), execs.Load(), "1200 ids: three UPDATEs of at most 500, not 1200")

	// the stamp reaches a message past the first chunk
	require.NoError(t, s.LinkCommentMessage(ctx, "team-a", 1150, 2, "sess-dev"))
	_, _, err = s.CreateArtifactAsk(ctx, 2, artA, "team-a", "sess-dev", "Dev", t0)
	require.NoError(t, err)
	n, err = s.MarkCommentMessagesRead(ctx, "team-a", "sess-dev", ids, t0.Add(2*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, 1, n, "a link in the third chunk is stamped")
}
