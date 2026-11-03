package agent

import (
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// shareFake makes dir a folder on a "share" whose stat the test controls: it blocks until release is closed (or answers at once when release is nil), and counts its calls.
type shareFake struct {
	calls   atomic.Int32
	release chan struct{}
	now     time.Time
	mu      sync.Mutex
}

func (f *shareFake) clock() time.Time     { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
func (f *shareFake) move(d time.Duration) { f.mu.Lock(); f.now = f.now.Add(d); f.mu.Unlock() }

func useShareFake(t *testing.T, dir string, release chan struct{}) *shareFake {
	t.Helper()
	f := &shareFake{release: release, now: time.Date(2026, 11, 3, 8, 0, 0, 0, time.UTC)}
	prevStat, prevNow, prevOn, prevLimit := shareStat, shareNow, onShareFolder, shareProbeLimit
	shareStat = func(p string) (os.FileInfo, error) {
		f.calls.Add(1)
		f.mu.Lock()
		r := f.release
		f.mu.Unlock()
		if r != nil {
			<-r
		}
		return os.Stat(p)
	}
	shareNow = f.clock
	onShareFolder = func(d string) bool { return d == dir }
	shareProbeLimit = 80 * time.Millisecond
	shareMu.Lock()
	shareFolders = map[string]*shareFolder{}
	shareMu.Unlock()
	t.Cleanup(func() {
		shareStat, shareNow, onShareFolder, shareProbeLimit = prevStat, prevNow, prevOn, prevLimit
		shareMu.Lock()
		shareFolders = map[string]*shareFolder{}
		shareMu.Unlock()
	})
	return f
}

func TestAShareThatAnswersIsSearchedAsALocalFolderIs(t *testing.T) {
	dir := t.TempDir()
	f := useShareFake(t, dir, nil)
	assert.True(t, shareAnswers(dir))
	assert.Equal(t, int32(1), f.calls.Load(), "one probe: a stat of the folder")
	assert.False(t, shareNotAnswered(dir))
}

func TestALocalFolderIsNeverProbed(t *testing.T) {
	dir := t.TempDir()
	f := useShareFake(t, "a folder that is not this one", nil)
	assert.True(t, shareAnswers(dir))
	assert.Zero(t, f.calls.Load(), "only a folder on a share is probed")
}

func TestAShareThatDoesNotAnswerIsSkippedWithinTheLimitAndForTheQuietTime(t *testing.T) {
	dir := t.TempDir()
	release := make(chan struct{})
	f := useShareFake(t, dir, release)
	t.Cleanup(func() { close(release) })

	start := time.Now()
	assert.False(t, shareAnswers(dir), "not answered in time")
	assert.Less(t, time.Since(start), 2*time.Second, "the check is not held by the share")
	assert.True(t, shareNotAnswered(dir))

	start = time.Now()
	assert.False(t, shareAnswers(dir), "still marked: skipped at once")
	assert.Less(t, time.Since(start), shareProbeLimit, "no second wait while it is marked")
	assert.Equal(t, int32(1), f.calls.Load(), "no second probe while it is marked")

	f.move(shareQuiet + time.Second)
	assert.False(t, shareNotAnswered(dir), "the mark expires on its own")
}

func TestOneProbePerFolderAtATime(t *testing.T) {
	dir := t.TempDir()
	release := make(chan struct{})
	f := useShareFake(t, dir, release)
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); shareAnswers(dir) }()
	}
	wg.Wait()
	assert.Equal(t, int32(1), f.calls.Load(), "five lookups at once, one stat of the share")
	f.move(shareQuiet + time.Second) // the mark expired, the first stat still hangs: a new lookup waits on it, it does not start another
	assert.False(t, shareAnswers(dir))
	assert.Equal(t, int32(1), f.calls.Load(), "still the one stat in flight")
	close(release)
}

// A stat that answers after the limit is thrown away: the folder stays skipped until its mark expires, and then it is looked at afresh.
func TestALateAnswerIsThrownAway(t *testing.T) {
	dir := t.TempDir()
	release := make(chan struct{})
	f := useShareFake(t, dir, release)
	assert.False(t, shareAnswers(dir))
	close(release) // the late answer: the folder is there
	require.Eventually(t, func() bool { shareMu.Lock(); defer shareMu.Unlock(); return shareFolders[dir].inflight == nil }, 2*time.Second, 5*time.Millisecond)
	assert.False(t, shareAnswers(dir), "the late answer is not used: still marked")
	f.move(shareQuiet + time.Second)
	f.mu.Lock()
	f.release = nil
	f.mu.Unlock()
	assert.True(t, shareAnswers(dir), "after the mark, a fresh probe")
	assert.Equal(t, int32(2), f.calls.Load())
}
