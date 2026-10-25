package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// QA probes for #7355 (goal events in the feed), through the real router, a real WebSocket and the real triggers.

type qaEnv struct {
	t      *testing.T
	srv    *Server
	local  *httptest.Server
	cookie string
	dir    string
	raw    *sql.DB
	stack  termStack
}

func newQAEnv(t *testing.T) *qaEnv {
	dir := t.TempDir()
	cfg := newE2EConfig(t, dir)
	cfg.StrictLocalAuth = true
	db, err := storetest.Open(t, cfg.DBPath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stack := newTermStack(t)
	srv := mustServer(NewWithKey(cfg, db, stack.backend, stack.terminal, ""))
	t.Cleanup(srv.Close)
	local := httptest.NewServer(srv.Router())
	t.Cleanup(local.Close)
	r := httptest.NewRequest("GET", local.URL+"/", nil)
	tok, err := srv.keyStore.NewSession(r, auth.SessionByPassword, false)
	require.NoError(t, err)
	c := &http.Cookie{Name: srv.keyStore.SessionCookieName(r), Value: tok}
	raw, err := sql.Open("sqlite", filepath.Join(cfg.CoralDir(), "messageboard.db"))
	require.NoError(t, err)
	t.Cleanup(func() { raw.Close() })
	return &qaEnv{t: t, srv: srv, local: local, cookie: c.String(), dir: dir, raw: raw, stack: stack}
}

type qaConn struct {
	t      *testing.T
	conn   *websocket.Conn
	frames chan map[string]any
}

func (e *qaEnv) dial(hdr http.Header) *qaConn {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	e.t.Cleanup(cancel)
	h := http.Header{"Origin": {e.local.URL}}
	for k, v := range hdr {
		h[k] = v
	}
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.local.URL, "http")+"/ws/coral", &websocket.DialOptions{HTTPHeader: h})
	require.NoError(e.t, err)
	e.t.Cleanup(func() { conn.CloseNow() })
	c := &qaConn{t: e.t, conn: conn, frames: make(chan map[string]any, 4096)}
	go func() {
		for {
			_, b, err := conn.Read(ctx)
			if err != nil {
				close(c.frames)
				return
			}
			var m map[string]any
			if json.Unmarshal(b, &m) == nil {
				c.frames <- m
			}
		}
	}()
	return c
}

func (e *qaEnv) operator() *qaConn { return e.dial(http.Header{"Cookie": {e.cookie}}) }

// first waits for the first frame that carries goals_brief (the starting frame).
func (c *qaConn) first() map[string]any {
	deadline := time.After(15 * time.Second)
	for {
		select {
		case m, ok := <-c.frames:
			if !ok {
				c.t.Fatal("feed ended before the first frame")
			}
			if _, has := m["goals_brief"]; has || m["type"] == "coral_update" {
				return m
			}
		case <-deadline:
			c.t.Fatal("no first frame")
		}
	}
}

// drain collects every frame for d and returns all goal events, whether any frame said gap, and the raw frames.
func (c *qaConn) drain(d time.Duration) (events []board.GoalEvent, gaps int, raw []string) {
	end := time.After(d)
	for {
		select {
		case m, ok := <-c.frames:
			if !ok {
				return
			}
			b, _ := json.Marshal(m)
			if _, has := m["goal_events"]; has || m["goal_events_gap"] != nil {
				raw = append(raw, string(b))
			}
			if g, _ := m["goal_events_gap"].(bool); g {
				gaps++
			}
			if arr, ok := m["goal_events"].([]any); ok {
				bb, _ := json.Marshal(arr)
				var evs []board.GoalEvent
				_ = json.Unmarshal(bb, &evs)
				events = append(events, evs...)
			}
		case <-end:
			return
		}
	}
}

func (e *qaEnv) count(q string, args ...any) int {
	var n int
	require.NoError(e.t, e.raw.QueryRow(q, args...).Scan(&n))
	return n
}

func (e *qaEnv) goal(boardID, title string) *board.Goal {
	g, err := e.srv.boardStore.CreateGoal(context.Background(), boardID, board.GoalInput{Title: title, CreatedBy: "Orchestrator"})
	require.NoError(e.t, err)
	return g
}

func sp(s string) *string { return &s }

// burst changes goal id's title n times in ONE transaction on the board's database: the triggers write each change's event inside it, so every event becomes visible together at the commit and one
// feed tick sees all n, however slow the machine writing them is (n separate UpdateGoal calls spread over several ticks on a slow runner, and each tick's frame then held 50 or fewer: no gap, #7551).
// pause is a delay between the writes inside the transaction, to show that.
func (e *qaEnv) burst(id int64, n int, pause time.Duration) {
	e.t.Helper()
	var err error
	for try := 0; try < 50; try++ { // the server's own writer may hold the database for a moment
		var tx *sql.Tx
		if tx, err = e.raw.Begin(); err != nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		for i := 0; i < n && err == nil; i++ {
			_, err = tx.Exec(`UPDATE board_goals SET title = ? WHERE board_id = 'team-a' AND id = ?`, fmt.Sprintf("t%d", i), id)
			if pause > 0 {
				time.Sleep(pause)
			}
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	require.NoError(e.t, err)
}

// 1: many changes inside one tick come as that many events, in order, no gap.
func TestQA7355ManyChangesInOneTick(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	g := e.goal("team-a", "base")
	c := e.operator()
	c.first()
	c.drain(1500 * time.Millisecond)
	for i := 0; i < 20; i++ {
		_, err := e.srv.boardStore.UpdateGoal(ctx, "team-a", g.ID, board.GoalUpdate{Title: sp(fmt.Sprintf("t%d", i))})
		require.NoError(t, err)
	}
	evs, gaps, _ := c.drain(3 * time.Second)
	t.Logf("20 changes in a tight loop: %d events, %d gap frames", len(evs), gaps)
	assert.Len(t, evs, 20)
	assert.Zero(t, gaps)
	for i := 1; i < len(evs); i++ {
		assert.Equal(t, evs[i-1].Seq+1, evs[i].Seq, "ordered and contiguous")
	}
}

// 2: more than 50 changes: gap, at most 50 events, and the next tick repeats nothing.
func TestQA7355MoreThanFiftyIsAGap(t *testing.T) {
	e := newQAEnv(t)
	g := e.goal("team-a", "base")
	c := e.operator()
	c.first()
	c.drain(1500 * time.Millisecond)
	e.burst(g.ID, 70, 0)
	evs, gaps, _ := c.drain(3 * time.Second)
	t.Logf("70 changes: %d events, %d gap frames", len(evs), gaps)
	assert.GreaterOrEqual(t, gaps, 1, "more than a frame can hold says gap")
	assert.LessOrEqual(t, len(evs), 50)
	more, gaps2, _ := c.drain(3 * time.Second)
	assert.Empty(t, more, "nothing repeated on later ticks")
	assert.Zero(t, gaps2, "no gap repeated on later ticks")
}

// 3: a connection that is behind a pruned window is told it missed some.
func TestQA7355PrunedPastIsAGap(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	g := e.goal("team-a", "base")
	c := e.operator()
	c.first()
	c.drain(1500 * time.Millisecond)
	for i := 0; i < 8; i++ {
		_, err := e.srv.boardStore.UpdateGoal(ctx, "team-a", g.ID, board.GoalUpdate{Title: sp(fmt.Sprintf("t%d", i))})
		require.NoError(t, err)
	}
	n, err := e.srv.boardStore.PruneGoalEvents(ctx, 3)
	require.NoError(t, err)
	t.Logf("pruned %d rows before the tick", n)
	evs, gaps, _ := c.drain(3 * time.Second)
	t.Logf("after prune to 3: %d events, %d gap frames", len(evs), gaps)
	assert.GreaterOrEqual(t, gaps, 1, "the window does not reach back to what the connection saw")
	for _, ev := range evs {
		assert.Greater(t, ev.Seq, int64(1))
	}
}

// 4: two boards; the operator sees both, an agent of A sees only A, an agent with no board none.
func TestQA7355TwoBoardsAndAgentScope(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	ss := store.NewSessionStore(e.srv.db)
	str := func(s string) *string { return &s }
	const sidA, sidN = "aaaaaaaa-7355-4000-8000-0000000000a1", "cccccccc-7355-4000-8000-0000000000c1"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sidA, AgentType: "claude", AgentName: "agent-a", WorkingDir: t.TempDir(), Prompt: str("p"), BoardName: str("team-a"), DisplayName: str("agent-a")}))
	_, err := e.srv.boardStore.Subscribe(ctx, "team-a", "agent-a", "dev", "claude-"+sidA, nil, "all")
	require.NoError(t, err)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sidN, AgentType: "claude", AgentName: "agent-n", WorkingDir: t.TempDir(), Prompt: str("p"), DisplayName: str("agent-n")}))
	tokA, err := e.srv.db.MintSessionToken(ctx, sidA, "claude-"+sidA)
	require.NoError(t, err)
	tokN, err := e.srv.db.MintSessionToken(ctx, sidN, "claude-"+sidN)
	require.NoError(t, err)
	require.NoError(t, e.stack.backend.Spawn("claude-"+sidA, "claude", t.TempDir(), sidA, "", 80, 24))
	require.NoError(t, e.stack.backend.Spawn("claude-"+sidN, "claude", t.TempDir(), sidN, "", 80, 24))
	// the two sessions are ended with the test: a process left running is a goroutine the package's leak check (testleak, #4167) reports at the end
	t.Cleanup(func() { _ = e.stack.backend.Kill("claude-" + sidA); _ = e.stack.backend.Kill("claude-" + sidN) })
	ga := e.goal("team-a", "A goal")
	gb := e.goal("team-b", "B goal")

	op := e.operator()
	ag := e.dial(http.Header{"X-Coral-Session-Token": {tokA}})
	nb := e.dial(http.Header{"X-Coral-Session-Token": {tokN}})
	op.first()
	f1 := ag.first()
	rows, _ := f1["sessions"].([]any)
	t.Logf("agent first frame: %d session rows, keys %v", len(rows), func() []string {
		var k []string
		for x := range f1 {
			k = append(k, x)
		}
		return k
	}())
	for _, r := range rows {
		m, _ := r.(map[string]any)
		t.Logf("row %v board_project=%v", m["session_id"], m["board_project"])
	}
	nb.first()
	op.drain(1500 * time.Millisecond)
	ag.drain(100 * time.Millisecond)
	nb.drain(100 * time.Millisecond)
	_, err = e.srv.boardStore.UpdateGoal(ctx, "team-a", ga.ID, board.GoalUpdate{Title: sp("A2")})
	require.NoError(t, err)
	_, err = e.srv.boardStore.UpdateGoal(ctx, "team-b", gb.ID, board.GoalUpdate{Title: sp("B2")})
	require.NoError(t, err)
	opEv, opGap, _ := op.drain(3 * time.Second)
	t.Logf("operator: %d events, gaps %d: %v", len(opEv), opGap, opEv)
	boards := map[string]int{}
	for _, ev := range opEv {
		boards[ev.Board]++
	}
	assert.Equal(t, 1, boards["team-a"])
	assert.Equal(t, 1, boards["team-b"])
	agEv, agGap, agRaw := ag.drain(100 * time.Millisecond)
	t.Logf("agent of team-a: %d events %v, gap frames %d", len(agEv), agEv, agGap)
	for _, ev := range agEv {
		assert.Equal(t, "team-a", ev.Board, "an agent sees its own board's events only")
	}
	assert.Len(t, agEv, 1)
	_ = agRaw
	nbEv, nbGap, _ := nb.drain(100 * time.Millisecond)
	t.Logf("agent with no board: %d events, gap frames %d", len(nbEv), nbGap)
	assert.Empty(t, nbEv, "an agent with no board sees no events")
}

// 5: no text in events or frames, and the event is exactly four keys.
func TestQA7355NoTextInEvents(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	c := e.operator()
	c.first()
	c.drain(1500 * time.Millisecond)
	const marker = "QAMARKER-secret-7355"
	g, err := e.srv.boardStore.CreateGoal(ctx, "team-a", board.GoalInput{Title: marker + "-title", Outcome: marker + "-outcome", DoneWhen: marker + "-done", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	_, err = e.srv.boardStore.UpdateGoal(ctx, "team-a", g.ID, board.GoalUpdate{State: sp("blocked"), BlockedOn: sp(marker + "-blocked")})
	require.NoError(t, err)
	_, _, err = e.srv.boardStore.CloseGoal(ctx, "team-a", g.ID, marker+"-reason", "done")
	require.NoError(t, err)
	evs, _, raw := c.drain(3 * time.Second)
	require.NotEmpty(t, evs)
	for _, r := range raw {
		assert.NotContains(t, r, marker, "no goal text in a frame that carries events")
	}
	for _, r := range raw {
		var m map[string]any
		require.NoError(t, json.Unmarshal([]byte(r), &m))
		for _, ev := range m["goal_events"].([]any) {
			keys := map[string]bool{}
			for k := range ev.(map[string]any) {
				keys[k] = true
			}
			assert.Equal(t, map[string]bool{"board": true, "goal": true, "kind": true, "seq": true}, keys)
		}
	}
	kinds := []string{}
	for _, ev := range evs {
		kinds = append(kinds, ev.Kind)
	}
	t.Logf("kinds: %v", kinds)
}

// 6: a no-op write emits nothing and moves nothing.
func TestQA7355NoOpWriteEmitsNothing(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	g := e.goal("team-a", "same")
	tk, err := e.srv.boardStore.CreateTask(ctx, "team-a", "a task", "b", "medium", "Orchestrator")
	require.NoError(t, err)
	require.NoError(t, e.srv.boardStore.SetTaskGoal(ctx, "team-a", tk.ID, &g.ID))
	c := e.operator()
	c.first()
	c.drain(1500 * time.Millisecond)
	before := e.count(`SELECT COUNT(*) FROM board_goal_events`)
	var seq0 int
	require.NoError(t, e.raw.QueryRow(`SELECT seq FROM board_goal_meta WHERE board_id='team-a'`).Scan(&seq0))
	_, err = e.srv.boardStore.UpdateGoal(ctx, "team-a", g.ID, board.GoalUpdate{Title: sp("same")})
	t.Logf("same title: err=%v", err)
	_, err = e.srv.boardStore.UpdateGoal(ctx, "team-a", g.ID, board.GoalUpdate{State: sp("active")})
	t.Logf("same state: err=%v", err)
	_, err = e.srv.boardStore.UpdateGoal(ctx, "team-a", g.ID, board.GoalUpdate{Driver: sp("")})
	t.Logf("same driver: err=%v", err)
	err = e.srv.boardStore.SetTaskGoal(ctx, "team-a", tk.ID, &g.ID)
	t.Logf("same task goal: err=%v", err)
	_, _, err = e.srv.boardStore.UpdateTask(ctx, "team-a", tk.ID, board.TaskUpdate{Title: sp("renamed task")}, 0)
	t.Logf("task rename (not a goal change): err=%v", err)
	after := e.count(`SELECT COUNT(*) FROM board_goal_events`)
	var seq1 int
	require.NoError(t, e.raw.QueryRow(`SELECT seq FROM board_goal_meta WHERE board_id='team-a'`).Scan(&seq1))
	assert.Equal(t, before, after, "no event row")
	assert.Equal(t, seq0, seq1, "no counter move")
	evs, gaps, _ := c.drain(3 * time.Second)
	assert.Empty(t, evs)
	assert.Zero(t, gaps)
}

// 7: the prune keeps 1000 per board; the newest; the job does the same; keep 0 is refused.
func TestQA7355PruneKeepsThousandPerBoard(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	ga := e.goal("team-a", "a")
	gb := e.goal("team-b", "b")
	for i := 0; i < 1200; i++ {
		_, err := e.srv.boardStore.UpdateGoal(ctx, "team-a", ga.ID, board.GoalUpdate{Title: sp(fmt.Sprintf("a%d", i))})
		require.NoError(t, err)
	}
	for i := 0; i < 100; i++ {
		_, err := e.srv.boardStore.UpdateGoal(ctx, "team-b", gb.ID, board.GoalUpdate{Title: sp(fmt.Sprintf("b%d", i))})
		require.NoError(t, err)
	}
	a0, b0 := e.count(`SELECT COUNT(*) FROM board_goal_events WHERE board_id='team-a'`), e.count(`SELECT COUNT(*) FROM board_goal_events WHERE board_id='team-b'`)
	t.Logf("before: team-a %d, team-b %d", a0, b0)
	_, err := e.srv.boardStore.PruneGoalEvents(ctx, 0)
	assert.Error(t, err, "keeping none is refused")
	n, err := e.srv.boardStore.PruneGoalEvents(ctx, 1000)
	require.NoError(t, err)
	a1, b1 := e.count(`SELECT COUNT(*) FROM board_goal_events WHERE board_id='team-a'`), e.count(`SELECT COUNT(*) FROM board_goal_events WHERE board_id='team-b'`)
	t.Logf("pruned %d: team-a %d, team-b %d", n, a1, b1)
	assert.Equal(t, 1000, a1)
	assert.Equal(t, b0, b1, "a board under the limit loses nothing")
	var minSeq, maxSeq int
	require.NoError(t, e.raw.QueryRow(`SELECT MIN(seq), MAX(seq) FROM board_goal_events WHERE board_id='team-a'`).Scan(&minSeq, &maxSeq))
	assert.Equal(t, 1000, maxSeq-minSeq+1, "the newest thousand, contiguous")
	n2, err := e.srv.boardStore.PruneGoalEvents(ctx, 1000)
	require.NoError(t, err)
	assert.Zero(t, n2, "a second prune deletes nothing")
	// the window the feed reads is still the newest 51 and reaches the head
	win, err := e.srv.boardStore.GoalEventsWindow(ctx, []string{"team-a", "team-b"}, 51)
	require.NoError(t, err)
	assert.Len(t, win["team-a"], 51)
	assert.Equal(t, int64(maxSeq), win["team-a"][50].Seq)
}

// 8: deleting a board: what is left of its events and counter.
func TestQA7355DeletedBoardLeavesEvents(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	g := e.goal("team-gone", "x")
	tk, err := e.srv.boardStore.CreateTask(ctx, "team-gone", "t", "b", "medium", "Orchestrator")
	require.NoError(t, err)
	require.NoError(t, e.srv.boardStore.SetTaskGoal(ctx, "team-gone", tk.ID, &g.ID))
	before := e.count(`SELECT COUNT(*) FROM board_goal_events WHERE board_id='team-gone'`)
	require.NoError(t, e.srv.boardStore.DeleteProject(ctx, "team-gone"))
	after := e.count(`SELECT COUNT(*) FROM board_goal_events WHERE board_id='team-gone'`)
	meta := e.count(`SELECT COUNT(*) FROM board_goal_meta WHERE board_id='team-gone'`)
	goals := e.count(`SELECT COUNT(*) FROM board_goals WHERE board_id='team-gone'`)
	t.Logf("events before delete %d, after %d; board_goal_meta rows %d; goals %d", before, after, meta, goals)
	rows, err := e.raw.Query(`SELECT kind FROM board_goal_events WHERE board_id='team-gone' ORDER BY id`)
	require.NoError(t, err)
	var kinds []string
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		kinds = append(kinds, k)
	}
	rows.Close()
	t.Logf("kinds left: %v", kinds)
	g2 := e.goal("team-gone", "again")
	got, err := e.srv.boardStore.GoalBriefs(ctx)
	t.Logf("a board of the same name made again: goal %d, brief %+v err %v", g2.ID, got["team-gone"], err)
}

// 9: the window query with 20 boards of 1000 events each.
func TestQA7355WindowQueryCost(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	var boards []string
	for b := 0; b < 20; b++ {
		id := fmt.Sprintf("board-%02d", b)
		boards = append(boards, id)
		g := e.goal(id, "g")
		tx, err := e.raw.Begin()
		require.NoError(t, err)
		for i := 0; i < 1000; i++ {
			_, err = tx.Exec(`INSERT INTO board_goal_events (board_id, goal_id, kind, seq, at) VALUES (?, ?, 'goal_updated', ?, '2026-10-24T00:00:00Z')`, id, g.ID, i+2)
			require.NoError(t, err)
		}
		require.NoError(t, tx.Commit())
	}
	start := time.Now()
	win, err := e.srv.boardStore.GoalEventsWindow(ctx, boards, 51)
	require.NoError(t, err)
	d := time.Since(start)
	t.Logf("window of 51 for 20 boards x 1000 events: %v (%d boards)", d, len(win))
	start = time.Now()
	for i := 0; i < 20; i++ {
		_, _ = e.srv.boardStore.GoalEventsWindow(ctx, boards[:1], 51)
	}
	t.Logf("one board x20 reads: %v each", time.Since(start)/20)
}

// 10: concurrent writers: every counter value has its event(s), none twice, none missing.
func TestQA7355ConcurrentWritersKeepEventsAndCounterTogether(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	g1, g2 := e.goal("team-a", "one"), e.goal("team-a", "two")
	done := make(chan error, 8)
	for w := 0; w < 8; w++ {
		go func(w int) {
			var err error
			for i := 0; i < 25 && err == nil; i++ {
				g := g1
				if (w+i)%2 == 0 {
					g = g2
				}
				_, err = e.srv.boardStore.UpdateGoal(ctx, "team-a", g.ID, board.GoalUpdate{Title: sp(fmt.Sprintf("w%d-%d", w, i))})
			}
			done <- err
		}(w)
	}
	for w := 0; w < 8; w++ {
		require.NoError(t, <-done)
	}
	var seq, events, distinct, minSeq int
	require.NoError(t, e.raw.QueryRow(`SELECT seq FROM board_goal_meta WHERE board_id='team-a'`).Scan(&seq))
	require.NoError(t, e.raw.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT seq), MIN(seq) FROM board_goal_events WHERE board_id='team-a'`).Scan(&events, &distinct, &minSeq))
	t.Logf("counter %d, events %d, distinct seq %d, first seq %d", seq, events, distinct, minSeq)
	assert.Equal(t, seq, events, "one event per counter move (two creates + 200 updates = 202 only if every title differed)")
	assert.Equal(t, events, distinct, "no counter value twice")
}

// 11: task states and moves between goals, and what kinds the feed names.
func TestQA7355TaskKinds(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	g1, g2 := e.goal("team-a", "one"), e.goal("team-a", "two")
	_, err := e.srv.boardStore.Subscribe(ctx, "team-a", "Dev", "dev", "dev-session", nil, "all")
	require.NoError(t, err)
	tk, err := e.srv.boardStore.CreateTaskWithOpts(ctx, "team-a", "t", "b", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &g1.ID})
	require.NoError(t, err)
	_, err = e.srv.boardStore.ClaimTask(ctx, "team-a", "Dev", tk.ID)
	require.NoError(t, err)
	_, err = e.srv.boardStore.CompleteTask(ctx, "team-a", tk.ID, "Dev", nil)
	require.NoError(t, err)
	require.NoError(t, e.srv.boardStore.SetTaskGoal(ctx, "team-a", tk.ID, &g2.ID))
	require.NoError(t, e.srv.boardStore.SetTaskGoal(ctx, "team-a", tk.ID, nil))
	rows, err := e.raw.Query(`SELECT kind, goal_id, seq FROM board_goal_events WHERE board_id='team-a' ORDER BY id`)
	require.NoError(t, err)
	var out []string
	for rows.Next() {
		var k string
		var gid, seq int
		_ = rows.Scan(&k, &gid, &seq)
		out = append(out, fmt.Sprintf("%s(goal %d, seq %d)", k, gid, seq))
	}
	rows.Close()
	t.Logf("events: %v", out)
}

// 12: a board deleted and made again under the same name: the old incarnation's events are still in the table and the new counter starts at 1 again.
func TestQA7355RecreatedBoardDoesNotReplayTheOldBoardsEvents(t *testing.T) {
	e := newQAEnv(t)
	ctx := context.Background()
	g := e.goal("team-gone", "old")
	for i := 0; i < 3; i++ {
		_, err := e.srv.boardStore.UpdateGoal(ctx, "team-gone", g.ID, board.GoalUpdate{Title: sp(fmt.Sprintf("old%d", i))})
		require.NoError(t, err)
	}
	require.NoError(t, e.srv.boardStore.DeleteProject(ctx, "team-gone"))
	stale := e.count(`SELECT COUNT(*) FROM board_goal_events WHERE board_id='team-gone'`)
	t.Logf("rows left for the deleted board: %d", stale)
	c := e.operator()
	c.first()
	c.drain(1500 * time.Millisecond)
	g2 := e.goal("team-gone", "new") // the board is made again: counter 1
	_ = g2
	evs, gaps, _ := c.drain(3 * time.Second)
	t.Logf("one new goal on the recreated board: events seen %v, gap frames %d", evs, gaps)
	assert.Len(t, evs, 1, "one change, one event: stale events of the deleted board must not be replayed")
}
