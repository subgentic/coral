package routes

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// Two wakes of one sleeping agent that overlap (#12291, the Beta Tester: Sleep Team once, then Wake pressed several times) start it once. The second used to read the same sleeping row, build a
// second launch line (a new token, which revokes the first and deletes its file) and type it into the terminal the first had made: the running agent held a revoked token (every coral-board call
// answered 401) and the second line sat in its input box. The wake is one at a time for a session, and the one that waited finds the agent awake and does nothing.
func TestOverlappingWakesStartAnAgentOnce(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const sid = "6682ebdf-65a4-4396-8ef3-26ead8208b8c"
	name := naming.SessionName("claude", sid)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "orch", WorkingDir: t.TempDir(), IsSleeping: 1}))

	var minted atomic.Int32
	old := agent.SessionTokenMinter
	agent.SessionTokenMinter = func(string, string) string { minted.Add(1); return "" }
	t.Cleanup(func() { agent.SessionTokenMinter = old })

	reached, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	term.mu.Lock()
	term.onCall = func(method string) {
		if method == "CreateSession" {
			once.Do(func() { close(reached); <-release }) // the first wake stops in the middle of making the terminal
		}
	}
	term.mu.Unlock()

	read := func() *store.LiveSession { ls, err := ss.GetLiveSession(ctx, sid); require.NoError(t, err); return ls }
	var wg sync.WaitGroup
	errs := make([]error, 2)
	wg.Add(1)
	go func() { defer wg.Done(); errs[0] = h.wakeExistingSession(ctx, read()) }()
	<-reached
	second := read() // the second request read the row while it was still asleep
	require.Equal(t, 1, second.IsSleeping)
	wg.Add(1)
	go func() { defer wg.Done(); errs[1] = h.wakeExistingSession(ctx, second) }()
	time.Sleep(150 * time.Millisecond) // the second has had the time to go as far as it can
	close(release)
	wg.Wait()

	require.NoError(t, errs[0])
	require.NoError(t, errs[1])
	assert.EqualValues(t, 1, minted.Load(), "one launch line was built, so one token was minted: a second would revoke the first agent's")
	term.mu.Lock()
	defer term.mu.Unlock()
	assert.Len(t, term.sent[name+".0"], 1, "one launch line was typed: %v", term.sent)
}

// An auto-wake (a message reached an auto-asleep agent) and a person's Wake at the same moment start it once too: the two entry points share the one lock (v2.0.34 turns auto-sleep on for everyone,
// so this overlap is likelier than a double click).
func TestAnAutoWakeAndAPersonsWakeStartAnAgentOnce(t *testing.T) {
	r := newSleepRig(t)
	require.NoError(t, r.ss.SetSessionAutoSleeping(r.ctx, r.sid, time.Now()))
	var minted atomic.Int32
	old := agent.SessionTokenMinter
	agent.SessionTokenMinter = func(string, string) string { minted.Add(1); return "" }
	t.Cleanup(func() { agent.SessionTokenMinter = old })
	reached, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	r.term.mockSessionTerminal.mu.Lock()
	delete(r.term.mockSessionTerminal.sessions, r.name) // an auto-slept agent's terminal is gone: the wake makes a new one
	r.term.mockSessionTerminal.onCall = func(method string) {
		if method == "CreateSession" {
			once.Do(func() { close(reached); <-release })
		}
	}
	r.term.mockSessionTerminal.mu.Unlock()
	row, err := r.ss.GetLiveSession(r.ctx, r.sid)
	require.NoError(t, err)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); r.h.WakeIdleForDelivery(r.ctx, r.sid) }() // the delivery's wake
	<-reached
	wg.Add(1)
	go func() { defer wg.Done(); _ = r.h.wakeExistingSession(r.ctx, row) }() // the person's Wake, from a row read while it was asleep
	time.Sleep(150 * time.Millisecond)
	close(release)
	wg.Wait()
	assert.EqualValues(t, 1, minted.Load(), "one launch line, one token")
}
