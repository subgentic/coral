package background

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/tmux"
)

// A runtime whose server can be asked, for the watch for the terminal server going away (#12592).
type watchedRuntime struct {
	reconMockRuntime
	state tmux.ServerState
}

func (w *watchedRuntime) ServerState(context.Context) tmux.ServerState { return w.state }

const (
	lostSid1 = "11111111-1111-4111-8111-111111111111"
	lostSid2 = "22222222-2222-4222-8222-222222222222"
)

type lostRig struct {
	ss   *store.SessionStore
	rt   *watchedRuntime
	r    *SessionReconciler
	logs *bytes.Buffer
	got  []ServerLoss
}

func newLostRig(t *testing.T) *lostRig {
	t.Helper()
	db := setupTestDB(t)
	ss := store.NewSessionStore(db)
	rt := &watchedRuntime{reconMockRuntime: reconMockRuntime{alive: map[string]bool{}}}
	g := &lostRig{ss: ss, rt: rt, r: NewSessionReconciler(ss, rt, time.Hour), logs: &bytes.Buffer{}}
	g.r.logger = slog.New(slog.NewTextHandler(g.logs, nil))
	g.r.now = func() time.Time { return time.Date(2026, 11, 2, 18, 23, 30, 0, time.UTC) }
	g.r.SetOnServerLost(func(_ context.Context, l ServerLoss) { g.got = append(g.got, l) })
	registerAwake(t, ss, "claude", lostSid1)
	registerAwake(t, ss, "claude", lostSid2)
	rt.listed = []AgentInfo{{AgentType: "claude", SessionID: lostSid1}, {AgentType: "claude", SessionID: lostSid2}}
	rt.alive = map[string]bool{"claude-" + lostSid1: true, "claude-" + lostSid2: true}
	return g
}

func TestTheTerminalServerGoingAwayIsOneLoudLossAtOnce(t *testing.T) {
	g := newLostRig(t)
	ctx := context.Background()
	g.rt.state = tmux.ServerState{PID: 4242, Sessions: 2, Up: true, Known: true}
	g.r.reconcileOnce(ctx)
	if len(g.got) != 0 || strings.Contains(g.logs.String(), "gone") {
		t.Fatalf("a server that is up reports nothing: %v %s", g.got, g.logs)
	}

	g.rt.state = tmux.ServerState{Known: true} // the server is gone, and so is every pane
	g.rt.listed, g.rt.alive = nil, map[string]bool{}
	g.r.reconcileOnce(ctx) // ONE pass: no waiting for two misses per agent

	if len(g.got) != 1 || g.got[0].PID != 4242 || len(g.got[0].SessionIDs) != 2 || g.got[0].At.IsZero() {
		t.Fatalf("one loss with the last pid and both sessions: %+v", g.got)
	}
	line := g.logs.String()
	for _, want := range []string{"level=WARN", "the terminal server (tmux) is gone", "last_pid=4242", "lost_sessions=2", "time=2026-11-02T18:23:30Z"} {
		if !strings.Contains(line, want) {
			t.Errorf("the WARN line lacks %q:\n%s", want, line)
		}
	}
	if !isSleeping(t, g.ss, lostSid1) || !isSleeping(t, g.ss, lostSid2) {
		t.Error("both agents are asleep after the one pass")
	}

	g.r.reconcileOnce(ctx)
	g.r.reconcileOnce(ctx)
	if len(g.got) != 1 || strings.Count(g.logs.String(), "is gone") != 1 {
		t.Errorf("a loss is reported once, not on every pass: %d, %s", len(g.got), g.logs)
	}
}

func TestAServerNeverSeenUpOrNotKnownIsNotAReportedLoss(t *testing.T) {
	g := newLostRig(t)
	ctx := context.Background()
	g.rt.state = tmux.ServerState{Known: true} // down on the first pass: nothing was lost that this Coral saw
	g.r.reconcileOnce(ctx)
	if len(g.got) != 0 {
		t.Fatalf("a server never seen up is no loss: %+v", g.got)
	}

	g.rt.state = tmux.ServerState{PID: 7, Sessions: 2, Up: true, Known: true}
	g.r.reconcileOnce(ctx)
	g.rt.state = tmux.ServerState{} // a timeout or a version mismatch: cannot tell it from "gone"
	g.r.reconcileOnce(ctx)
	if len(g.got) != 0 || isSleeping(t, g.ss, lostSid1) {
		t.Fatalf("an answer that is not known reports nothing and puts nobody to sleep: %+v", g.got)
	}
}

func TestTheLastAgentEndedOnPurposeIsNotALostServer(t *testing.T) {
	g := newLostRig(t)
	ctx := context.Background()
	g.rt.state = tmux.ServerState{PID: 9, Sessions: 2, Up: true, Known: true}
	g.r.reconcileOnce(ctx)
	for _, sid := range []string{lostSid1, lostSid2} { // the Operator ended both: a server with no session exits by itself
		if err := g.ss.SetSessionSleeping(ctx, sid, true); err != nil {
			t.Fatal(err)
		}
	}
	g.rt.state = tmux.ServerState{Known: true}
	g.r.reconcileOnce(ctx)
	if len(g.got) != 0 || strings.Contains(g.logs.String(), "is gone") {
		t.Fatalf("no awake agent was in it: %+v %s", g.got, g.logs)
	}
}
