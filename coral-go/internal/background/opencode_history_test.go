package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/opencode"
	"github.com/subgentic/coral/internal/store"
)

type fakeOpencodeSessions struct {
	turns map[string]opencode.State
	at    map[string]time.Time
	msgs  map[string][]opencode.Message
	reads map[string]int
}

func (f *fakeOpencodeSessions) Keys() []string {
	var k []string
	for key := range f.msgs {
		k = append(k, key)
	}
	return k
}
func (f *fakeOpencodeSessions) AgentSession(key string) (opencode.State, time.Time, bool) {
	s, ok := f.turns[key]
	return s, f.at[key], ok
}
func (f *fakeOpencodeSessions) AgentMessages(_ context.Context, key string) ([]opencode.Message, bool, error) {
	f.reads[key]++
	return f.msgs[key], true, nil
}

const ocAgent = "11111111-2222-4333-8444-5555555555aa"

func newFakeOpencode() *fakeOpencodeSessions {
	now := time.Now()
	return &fakeOpencodeSessions{
		turns: map[string]opencode.State{ocAgent: opencode.StateIdle},
		at:    map[string]time.Time{ocAgent: now},
		msgs: map[string][]opencode.Message{ocAgent: {
			{Role: "user", Text: "You have 2 unread messages on the message board. Run coral-board read.", At: "1761862800000"},
			{Role: "user", Text: "please refactor the quokka parser", At: "1761862860000"},
			{Role: "assistant", Text: "the quokka parser now streams tokens", At: "1761862920000"},
		}},
		reads: map[string]int{},
	}
}

// #11383: opencode agents' conversations are in the History index and its search, read through their servers' message API.
func TestIndexerListsAndSearchesAnOpencodeAgentsChatThroughItsServer(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenWithKey(ctx, filepath.Join(t.TempDir(), "sessions.db"), "")
	require.NoError(t, err)
	defer db.Close()
	fake := newFakeOpencode()
	idx := NewSessionIndexer(store.NewSessionStore(db), nil, time.Hour, 0)
	idx.AddLiveSource(NewOpencodeHistory(fake))
	require.NoError(t, idx.RunOnce(ctx))

	var row struct {
		SourceType string `db:"source_type"`
		SourceFile string `db:"source_file"`
		First      string `db:"first_user_message"`
		Count      int    `db:"message_count"`
	}
	require.NoError(t, db.GetContext(ctx, &row, `SELECT source_type, source_file, COALESCE(first_user_message, '') AS first_user_message, message_count FROM session_index WHERE session_id = ?`, ocAgent))
	assert.Equal(t, "opencode", row.SourceType)
	assert.Equal(t, agent.OpencodeSourcePrefix+ocAgent, row.SourceFile, "a label, never a path of this computer or the server")
	assert.Equal(t, "please refactor the quokka parser", row.First, "what Coral typed is not the first message")
	assert.Equal(t, 3, row.Count)
	var hits int
	require.NoError(t, db.GetContext(ctx, &hits, `SELECT COUNT(*) FROM session_fts WHERE session_id = ? AND session_fts MATCH ?`, ocAgent, `"quokka" AND "streams"`))
	assert.Greater(t, hits, 0, "what was said is searchable")
	assert.Equal(t, 1, fake.reads[ocAgent])

	// the next pass: nothing changed, so nothing is read
	require.NoError(t, idx.RunOnce(ctx))
	assert.Equal(t, 1, fake.reads[ocAgent], "an unchanged session costs no read")

	// the agent speaks again: its last change is newer, so it is read once more
	fake.at[ocAgent] = time.Now().Add(time.Minute)
	require.NoError(t, idx.RunOnce(ctx))
	assert.Equal(t, 2, fake.reads[ocAgent])
}

func TestTheOpencodeSourceLeavesAnAgentThatIsWorkingOrHasNoSessionYet(t *testing.T) {
	fake := newFakeOpencode()
	src := NewOpencodeHistory(fake)
	fake.turns[ocAgent] = opencode.StateWorking
	assert.Empty(t, src.ExtractLive(context.Background(), map[string]float64{}), "a turn going on: its row waits for the turn to end")
	assert.Zero(t, fake.reads[ocAgent], "and it is not read")
	delete(fake.turns, ocAgent)
	assert.Empty(t, src.ExtractLive(context.Background(), map[string]float64{}), "no session named yet: nothing to index")
	assert.Zero(t, fake.reads[ocAgent])
	fake.turns[ocAgent] = opencode.StateFailed
	assert.Len(t, src.ExtractLive(context.Background(), map[string]float64{}), 1, "a failed turn has ended")
}

type blockingSource struct {
	started chan struct{}
	release chan struct{}
}

func (b *blockingSource) ExtractLive(context.Context, map[string]float64) []agent.IndexedSession {
	close(b.started)
	<-b.release
	return nil
}

// A source may read many agents' servers one after another: the pass's lock is never held across it (Security's INFO 3, #137942).
func TestAPassDoesNotHoldItsLockWhileALiveSourceReads(t *testing.T) {
	ctx := context.Background()
	db, err := store.OpenWithKey(ctx, filepath.Join(t.TempDir(), "sessions.db"), "")
	require.NoError(t, err)
	defer db.Close()
	idx := NewSessionIndexer(store.NewSessionStore(db), nil, time.Hour, 0)
	src := &blockingSource{started: make(chan struct{}), release: make(chan struct{})}
	idx.AddLiveSource(src)
	done := make(chan error, 1)
	go func() { done <- idx.RunOnce(ctx) }()
	select {
	case <-src.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the source was never asked")
	}
	require.True(t, idx.runMu.TryLock(), "the pass's lock is free while the source reads")
	idx.runMu.Unlock()
	close(src.release)
	require.NoError(t, <-done)
}
