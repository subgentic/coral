package tmux

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #412: the wrapper check resolves links in paths that may be on a network mount that has stopped answering. A resolution that does not finish in time is "not recognised" (notices wait for a
// record); the wait is bounded; a path that is already being resolved, or timed out a moment ago, starts no second goroutine; a mount that keeps hanging cannot fill every slot (the resolved CLI
// has its own and is resolved once, when its row is written).

// hang makes evalSymlinks block for the paths isStuck names (until the returned release is called) and answer for every other path as the real one does. calls counts every call, by path.
type hang struct {
	mu      sync.Mutex
	calls   map[string]int
	gate    chan struct{}
	isStuck func(path string) bool
	once    sync.Once
}

func (h *hang) called(path string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls[path]
}
func (h *hang) total() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.calls {
		n += c
	}
	return n
}
func (h *hang) release() { h.once.Do(func() { close(h.gate) }) }

// useHang installs the blocking resolver, a short bound and a retry delay of retry, with empty state; the cleanup releases the stuck calls, waits for them and restores everything.
func useHang(t *testing.T, timeout, retry time.Duration, isStuck func(path string) bool) *hang {
	t.Helper()
	h := &hang{calls: map[string]int{}, gate: make(chan struct{}), isStuck: isStuck}
	oldEval, oldTimeout, oldRetry := evalSymlinks, resolveTimeout, resolveRetryDelay
	resetResolves()
	evalSymlinks = func(p string) (string, error) {
		h.mu.Lock()
		h.calls[p]++
		h.mu.Unlock()
		if h.isStuck(p) {
			<-h.gate
		}
		return filepath.EvalSymlinks(p)
	}
	resolveTimeout, resolveRetryDelay = timeout, retry
	t.Cleanup(func() {
		h.release()
		require.Eventually(t, func() bool { return resolvesInFlight() == 0 }, 5*time.Second, 10*time.Millisecond, "the stuck resolutions finish once the mount answers")
		evalSymlinks, resolveTimeout, resolveRetryDelay = oldEval, oldTimeout, oldRetry
		resetResolves()
	})
	return h
}

func resetResolves() {
	resolves.Lock()
	resolves.gaveUp = map[string]time.Time{}
	resolves.Unlock()
	cliResolved.Lock()
	cliResolved.m = map[string]string{}
	cliResolved.Unlock()
}

func scriptsIn(t *testing.T, dir string, names ...string) []string {
	t.Helper()
	var out []string
	for _, n := range names {
		p := filepath.Join(dir, n)
		require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755))
		out = append(out, p)
	}
	return out
}

func TestTheCLIPathThatCannotBeResolvedInTimeRecognisesNothing(t *testing.T) {
	_, cli := wrapperFixture(t)
	useHang(t, 100*time.Millisecond, time.Minute, func(p string) bool { return p == cli })
	start := time.Now()
	assert.Nil(t, wrapperIsCLI(cli), "a resolution that never answers recognises nothing")
	assert.Less(t, time.Since(start), 2*time.Second, "and does not wait for it")
}

func TestAScriptPathThatBlocksIsNotTheAgentAndTheNoticeWaits(t *testing.T) {
	_, cli := wrapperFixture(t)
	check := wrapperIsCLI(cli) // resolved while the mount answers
	require.NotNil(t, check)
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	rec := AgentProc{PID: 700, Start: t1}
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh")
	require.True(t, decideNotice(pane, 600, rec, check).OK, "while the mount answers")

	useHang(t, 300*time.Millisecond, time.Minute, func(p string) bool { return p == cli })
	start := time.Now()
	assert.False(t, check(700), "the script path cannot be resolved in time")
	took := time.Since(start)
	assert.GreaterOrEqual(t, took, 250*time.Millisecond, "it waited for the bound")
	assert.Less(t, took, 3*time.Second, "and not longer")
	assert.False(t, decideNotice(pane, 600, rec, check).OK, "fail safe: a recorded wrapper whose script cannot be resolved is not typed into")
}

// Ten checks on one hung path start ONE goroutine, and a check on another path still resolves.
func TestTenChecksOnOneHungPathStartOneGoroutine(t *testing.T) {
	dir, cli := wrapperFixture(t)
	check := wrapperIsCLI(cli)
	require.NotNil(t, check)
	scripts := scriptsIn(t, dir, "hung.sh")
	hung := scripts[0]
	withArgs(t, map[int][]string{700: {"/bin/sh", hung}, 701: {"/bin/sh", cli}}, nil)
	h := useHang(t, 100*time.Millisecond, time.Minute, func(p string) bool { return p == hung })

	assert.False(t, check(700), "the first waits out the bound")
	start := time.Now()
	for i := 0; i < 9; i++ { // the next nine are refused at once: not one more wait, not one more goroutine
		assert.False(t, check(700))
	}
	assert.Less(t, time.Since(start), 80*time.Millisecond, "nine more checks did not wait the bound again")
	assert.Equal(t, 1, h.called(hung), "one goroutine for the hung path")

	// ten at the same moment: they share the call (and the one already stuck), none starts another
	var wg sync.WaitGroup
	var started atomic.Int32
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); started.Add(1); _ = check(700) }()
	}
	wg.Wait()
	assert.Equal(t, 1, h.called(hung), "still one")

	assert.True(t, check(701), "a check on another path still resolves")
	assert.Equal(t, 1, h.called(cli), "once")
}

// Two asks for one path while it is being resolved share one call, and both get its answer.
func TestTwoAsksForOnePathShareOneCall(t *testing.T) {
	dir, cli := wrapperFixture(t)
	check := wrapperIsCLI(cli)
	require.NotNil(t, check)
	slow := scriptsIn(t, dir, "slow.sh")[0]
	withArgs(t, map[int][]string{700: {"/bin/sh", slow}}, nil)
	h := useHang(t, 2*time.Second, time.Minute, func(p string) bool { return p == slow })
	var wg sync.WaitGroup
	answers := make([]bool, 2)
	for i := range answers {
		wg.Add(1)
		go func() { defer wg.Done(); answers[i] = check(700) }()
	}
	require.Eventually(t, func() bool { return h.called(slow) >= 1 }, 2*time.Second, 5*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	h.release()
	wg.Wait()
	assert.Equal(t, 1, h.called(slow), "one goroutine for two asks")
	assert.Equal(t, []bool{false, false}, answers, "the script is not the CLI, but both got an answer, not a timeout")
}

// Many DIFFERENT hung paths cannot pile up: the fifth is refused at once. The resolved CLI is not refused for it.
func TestHungPathsAreCappedAndTheCLIIsNotAffected(t *testing.T) {
	dir, cli := wrapperFixture(t)
	check := wrapperIsCLI(cli)
	require.NotNil(t, check)
	paths := scriptsIn(t, dir, "a.sh", "b.sh", "c.sh", "d.sh", "e.sh")
	args := map[int][]string{}
	for i, p := range paths {
		args[700+i] = []string{"/bin/sh", p}
	}
	withArgs(t, args, nil)
	stuck := map[string]bool{}
	for _, p := range paths {
		stuck[p] = true
	}
	h := useHang(t, 200*time.Millisecond, time.Minute, func(p string) bool { return stuck[p] })
	for i := 0; i < maxStuckResolves; i++ {
		assert.False(t, check(700+i))
	}
	assert.Equal(t, maxStuckResolves, resolvesInFlight(), "the stuck ones are still in flight")

	start := time.Now()
	assert.False(t, check(700+maxStuckResolves), "the fifth hung path is refused at once")
	assert.Less(t, time.Since(start), 100*time.Millisecond, "without waiting and without another goroutine")
	assert.Equal(t, 0, h.called(paths[maxStuckResolves]))

	// a new CLI row is still resolved: it does not compete for those slots
	other := scriptsIn(t, dir, "other-cli.sh")[0]
	require.NotNil(t, wrapperIsCLI(other), "the CLI side is not refused while script paths are stuck")
}

// The CLI is resolved once when its row is written; a notice check does not resolve it again.
func TestTheCLIIsResolvedOnceWhenItsRowIsWritten(t *testing.T) {
	_, cli := wrapperFixture(t)
	const session = "claude-resolved-once"
	t.Cleanup(func() { NoteLaunchCLI(session, "") })
	h := useHang(t, time.Second, time.Minute, func(string) bool { return false })
	NoteLaunchCLI(session, cli)
	assert.Equal(t, 1, h.called(cli), "resolved when noted")
	for i := 0; i < 10; i++ {
		require.NotNil(t, WrapperCheckFor(session))
	}
	assert.Equal(t, 1, h.called(cli), "ten notice checks did not resolve it again")
	NoteLaunchCLI(session, cli) // the row is written again
	assert.Equal(t, 2, h.called(cli), "re-resolved only when a row is written")
}

func TestTheBoundDoesNotChangeWhatIsRecognisedWhenTheMountAnswers(t *testing.T) {
	dir, cli := wrapperFixture(t)
	check := wrapperIsCLI(cli)
	require.NotNil(t, check)
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}, 701: {"/bin/sh", filepath.Join(dir, "missing.sh")}}, nil)
	assert.True(t, check(700))
	assert.False(t, check(701))
	assert.Equal(t, 0, resolvesInFlight(), "nothing is left in flight")
}
