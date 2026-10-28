package board

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9706: the message search index is not built when the disk of the board file is under twice the text of the messages free: the state says low_disk, a search reads every message as before, and the next open tries again.
func TestMessageSearchIndexIsNotBuiltOnAFullDisk(t *testing.T) {
	ctx := context.Background()
	t.Setenv(messageSearchIndexEnv, "") // on
	path := filepath.Join(t.TempDir(), "board_lowdisk.db")
	var free atomic.Uint64
	var asked atomic.Int64
	var freeErr atomic.Bool
	old := messageIndexFreeSpace
	messageIndexFreeSpace = func(dir string) (uint64, error) {
		asked.Add(1)
		if freeErr.Load() {
			return 0, fmt.Errorf("no statfs here")
		}
		assert.Equal(t, filepath.Dir(path), dir, "the disk of the board file")
		return free.Load(), nil
	}
	t.Cleanup(func() { messageIndexFreeSpace = old })

	// a board with a known amount of text
	t.Setenv(messageSearchIndexEnv, "off")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	_, err = sub(s, ctx, "proj", "dev", "Dev")
	require.NoError(t, err)
	for i := 0; i < 40; i++ {
		_, err = s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s %d", ftsTexts[i%len(ftsTexts)], i), nil)
		require.NoError(t, err)
	}
	var text uint64
	require.NoError(t, s.db.GetContext(ctx, &text, `SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM board_messages`))
	need := text * 2
	require.NoError(t, s.Close())
	t.Setenv(messageSearchIndexEnv, "") // on
	open := func() *Store {
		s, err := NewStoreWithKey(path, "")
		require.NoError(t, err)
		t.Cleanup(func() { s.Close() })
		return s
	}

	// one byte under: not built, said so, a search is answered without the index, and three opens in a row build nothing
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	free.Store(need - 1)
	for i := 0; i < 3; i++ {
		asked.Store(0)
		s = open()
		assert.Equal(t, "low_disk", s.MessageSearchIndexState(), "open %d", i)
		assert.False(t, s.messageIndexExists(ctx), "no table was built")
		assert.Equal(t, int64(1), asked.Load(), "a full disk costs one statfs per open")
		st := s.MessageSearchIndexStatus(ctx)
		assert.Equal(t, "low_disk", st.State)
		assert.Equal(t, "on", st.Setting)
		assert.Zero(t, st.SizeBytes)
		a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"progress"}})
		assert.Equal(t, b, a, "the search answers as it did without an index")
		require.NoError(t, s.Close())
	}
	assert.Contains(t, logged.String(), "not building the message search index")
	assert.Equal(t, 3, strings.Count(logged.String(), "not building the message search index"), "said once at each open")

	// exactly twice the text is room
	free.Store(need)
	s = open()
	require.Eventually(t, func() bool { return s.MessageSearchIndexState() == "ready" }, 10*time.Second, 5*time.Millisecond, "built at the next open that has room")
	require.NoError(t, s.Close())

	// a reading that fails is not a low disk
	require.NoError(t, func() error { s = open(); _, e := s.DisableMessageSearchIndex(ctx, false); return e }())
	require.NoError(t, s.Close())
	freeErr.Store(true)
	s = open()
	require.Eventually(t, func() bool { return s.MessageSearchIndexState() == "ready" }, 10*time.Second, 5*time.Millisecond, "an unreadable disk does not turn the index off")
	require.NoError(t, s.Close())

	// a disk with more room than any board needs: the text is not even summed (the answer is the same), and an explicit Enable on a full disk is refused too
	freeErr.Store(false)
	free.Store(messageIndexNoCheckAbove)
	s = open()
	assert.Equal(t, "ready", s.MessageSearchIndexState())
	require.NoError(t, s.Close())
	s = open()
	_, err = s.DisableMessageSearchIndex(ctx, false)
	require.NoError(t, err)
	free.Store(1)
	s.EnableMessageSearchIndex(ctx)
	assert.Equal(t, "low_disk", s.MessageSearchIndexState(), "the explicit build asks the disk too")
	assert.False(t, s.messageIndexExists(ctx))
}
