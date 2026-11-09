package board

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15022 (Windows: TestStartReturnsTheAPIKeyError, "unlinkat ...messageboard.db: The process cannot access the file"): a store opened with the message index on starts a build or a check in the background, and Close
// only cancelled it: the goroutine could still be in a statement, holding the file, when Close returned and the folder was removed. Close now returns when they have ended.
func TestCloseReturnsOnlyWhenTheIndexGoroutinesHaveEnded(t *testing.T) {
	t.Setenv(messageSearchIndexEnv, "on") // a store builds or finds its index at open only when the setting is on
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	buildAfterOpenBuild(t, s, t.Context())
	require.NoError(t, s.Close()) // a complete index: the next open starts a check

	defer func(d time.Duration) { setMessageIndexTuning(func() { messageIndexCheckDelay = d }) }(messageIndexCheckDelay)
	setMessageIndexTuning(func() { messageIndexCheckDelay = time.Millisecond })
	defer func(q, p time.Duration) {
		setMessageIndexTuning(func() { messageIndexQuiet, messageIndexQuietPoll = q, p })
	}(messageIndexQuiet, messageIndexQuietPoll)
	setMessageIndexTuning(func() { messageIndexQuiet, messageIndexQuietPoll = time.Millisecond, time.Millisecond })
	entered, release := make(chan struct{}), make(chan struct{})
	var once, relOnce sync.Once
	letGo := func() { relOnce.Do(func() { close(release) }) }
	defer letGo()
	defer func() { setMessageIndexTuning(func() { messageIndexCheckHook = func() {} }) }()
	setMessageIndexTuning(func() { messageIndexCheckHook = func() { once.Do(func() { close(entered) }); <-release } })

	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	select {
	case <-entered:
	case <-time.After(30 * time.Second):
		t.Fatal("the check never started")
	}
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	select {
	case <-closed:
		t.Fatal("Close returned while the index's check was still running")
	case <-time.After(150 * time.Millisecond):
	}
	letGo()
	select {
	case err := <-closed:
		assert.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("Close did not return after the check ended")
	}
}
