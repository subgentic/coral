package routes

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAWatcherSkipsAnAgentWhoseLockIsHeldAndAnotherAgentIsFree(t *testing.T) {
	h := &SessionsHandler{}
	unlock := h.lockAgent("a")
	_, ok := h.tryLockAgent("a")
	assert.False(t, ok, "held: the watcher skips this pass")
	other, ok := h.tryLockAgent("b")
	require.True(t, ok, "one lock per agent")
	other()
	unlock()
	again, ok := h.tryLockAgent("a")
	require.True(t, ok, "free once released")
	again()
	assert.Zero(t, h.locks.size(), "no entry is left once nobody holds or waits")
}

func TestAPersonsAnswerWaitsForTheLockAndOnlyOneHolderAtATime(t *testing.T) {
	h := &SessionsHandler{}
	unlock, ok := h.tryLockAgent("a")
	require.True(t, ok)
	got := make(chan struct{})
	go func() {
		defer close(got)
		h.lockAgent("a")()
	}()
	select {
	case <-got:
		t.Fatal("the answer went while the close held the lock")
	case <-time.After(50 * time.Millisecond):
	}
	unlock()
	select {
	case <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the answer never got the lock")
	}
	assert.Zero(t, h.locks.size())
}

func TestUnlockTwiceIsOnce(t *testing.T) {
	h := &SessionsHandler{}
	unlock := h.lockAgent("a")
	unlock()
	unlock() // a second call must not unlock a lock someone else now holds
	held := h.lockAgent("a")
	_, ok := h.tryLockAgent("a")
	assert.False(t, ok, "still held after the first holder's double unlock")
	held()
	assert.Zero(t, h.locks.size())
}

func TestManyAgentsAndSendersNeverOverlapOnOneAgent(t *testing.T) {
	h := &SessionsHandler{}
	var mu sync.Mutex
	inside := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		sid := []string{"a", "b", "c"}[i%3]
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var unlock func()
			if i%2 == 0 {
				unlock = h.lockAgent(sid)
			} else {
				u, ok := h.tryLockAgent(sid)
				if !ok {
					return
				}
				unlock = u
			}
			mu.Lock()
			inside[sid]++
			n := inside[sid]
			mu.Unlock()
			assert.Equal(t, 1, n, "two senders on %s at once", sid)
			time.Sleep(time.Millisecond)
			mu.Lock()
			inside[sid]--
			mu.Unlock()
			unlock()
		}(i)
	}
	wg.Wait()
	assert.Zero(t, h.locks.size())
}
