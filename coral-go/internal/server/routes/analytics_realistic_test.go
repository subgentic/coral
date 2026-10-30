package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// A board shaped like ours, built synthetically in a temporary database (never ~/.coral): twelve agents, the Operator, the Coral Task Queue and the Health Monitor, relays to and from two other
// boards, goal requests, tasks and asks, and a month of token usage. A ledger of what the seed wrote is kept beside it, and every number the three Analytics tabs draw is checked against that ledger
// and against a direct count in SQL. With CORAL_WRITE_FIXTURES=<dir> the replies are written there as the fixture of tests/frontend/analytics_tabs_realistic.test.mjs, which checks what the tabs make of them.

var realisticAgents = []string{"Orchestrator", "Backend Dev", "Frontend Dev", "QA Reviewer 1", "QA Reviewer 2", "UI/UX", "Security Reviewer", "DevOps", "Data Science", "Docs Writer", "Mobile Beta Tester", "Lead Developer"}

type realisticLedger struct {
	PostsByDay     map[string]int
	OperatorByDay  map[string]int
	AutomatedByDay map[string]int
	CrossByDay     map[string]int
	DoneByDay      map[string]int
	Sent, Received map[string]int
	ToOperator     map[string]int
	AsksOperator   map[string]int
	Edges          map[string]int
	AgentPosts     int
	OperatorPosts  int
	Automated      int
	Cross          int
	Assigned       int
	Done           int
	OpAsks         [3]int // asked, answered, median
	AgentAsks      [3]int
	OpSlowest      int
	AgentSlowest   int
	Pairs          map[string][3]int // "from>to": messages, requests, accepted
}

func newLedger() *realisticLedger {
	return &realisticLedger{PostsByDay: map[string]int{}, OperatorByDay: map[string]int{}, AutomatedByDay: map[string]int{}, CrossByDay: map[string]int{}, DoneByDay: map[string]int{}, Sent: map[string]int{}, Received: map[string]int{}, ToOperator: map[string]int{}, AsksOperator: map[string]int{}, Edges: map[string]int{}, Pairs: map[string][3]int{}}
}

func TestEveryAnalyticsNumberMatchesADirectCountOnARealisticBoard(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	const team = "coral-go-team"
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	for _, a := range realisticAgents {
		_, err := bs.Subscribe(ctx, team, a, a, a, nil, "all")
		require.NoError(t, err)
	}
	seed := uint32(20261030)
	rnd := func(n int) int { seed = seed*1664525 + 1013904223; return int(seed>>8) % n }
	L := newLedger()
	at := func(daysAgo, hour, min int) time.Time {
		d := now.AddDate(0, 0, -daysAgo)
		return time.Date(d.Year(), d.Month(), d.Day(), hour, min, 0, 0, time.UTC)
	}
	stamp := func(table, idCol string, id int64, ts time.Time) {
		_, err := bs.Writer().ExecContext(ctx, fmt.Sprintf(`UPDATE %s SET created_at = ? WHERE %s = ?`, table, idCol), ts.Format(time.RFC3339), id)
		require.NoError(t, err)
	}
	dayOf := func(ts time.Time) string { return ts.Format("2006-01-02") }
	post := func(who, text string, ts time.Time) *board.Message {
		m, err := bs.PostMessage(ctx, team, who, text, nil)
		require.NoError(t, err)
		stamp("board_messages", "id", m.ID, ts)
		return m
	}
	// agent messages: 13 days (the 14th is the day of the window's start), with @mentions the ledger counts the way the read must
	agentPost := func(who string, mentions []string, withOperator bool, ts time.Time) *board.Message {
		text := "update on the work"
		for _, m := range mentions {
			text += " @" + m + " please look"
		}
		if withOperator {
			text += " @Operator a question"
		}
		m := post(who, text, ts)
		L.AgentPosts++
		L.PostsByDay[dayOf(ts)]++
		L.Sent[who]++
		seen := map[string]bool{}
		for _, to := range mentions {
			if to == who || seen[to] {
				continue
			}
			seen[to] = true
			L.Received[to]++
			L.Edges[who+">"+to]++
		}
		if withOperator {
			L.ToOperator[who]++
		}
		return m
	}
	for day := 13; day >= 0; day-- {
		for i, who := range realisticAgents {
			for k := 0; k < 2+rnd(4); k++ {
				var ms []string
				for j := 0; j < rnd(3); j++ {
					ms = append(ms, realisticAgents[rnd(len(realisticAgents))])
				}
				agentPost(who, ms, rnd(9) == 0, at(day, 6+i%6, k))
			}
		}
		// Coral's own notices, and the Operator's posts
		for k := 0; k < 3+rnd(3); k++ {
			who := []string{"Coral Task Queue", "Coral Health Monitor"}[rnd(2)]
			post(who, "notice @Backend Dev a task is ready", at(day, 8, k))
			L.Automated++
			L.AutomatedByDay[dayOf(at(day, 8, 0))]++
		}
		for k := 0; k < rnd(3); k++ {
			post("Operator", "go ahead", at(day, 11, 30+k))
			L.OperatorPosts++
			L.OperatorByDay[dayOf(at(day, 11, 0))]++
		}
	}
	// asks: three to the Operator (two answered after 2 min and 2 h, one not), two between agents (answered after 5 and 15 min)
	ask := func(asker string, asked []string, answerer string, wait time.Duration, ts time.Time, op bool) {
		m := agentPost(asker, nil, op, ts)
		require.NoError(t, bs.RecordAsk(ctx, team, m, asked))
		_, err := bs.Writer().ExecContext(ctx, `UPDATE board_asks SET created_at = ? WHERE message_id = ?`, ts.Format(time.RFC3339), m.ID)
		require.NoError(t, err)
		bucket := &L.AgentAsks
		if op {
			bucket = &L.OpAsks
			L.AsksOperator[asker]++
		}
		bucket[0]++
		if wait > 0 {
			rts := ts.Add(wait)
			var r *board.Message
			if op {
				r = post("Operator", "answer", rts)
				L.OperatorPosts++
				L.OperatorByDay[dayOf(rts)]++
			} else {
				r = agentPost(answerer, nil, false, rts)
			}
			require.NoError(t, bs.RecordReply(ctx, team, r.ID, m.ID))
			bucket[1]++
		}
	}
	ask("Backend Dev", []string{"Operator"}, "", 2*time.Minute, at(5, 10, 0), true)
	ask("DevOps", []string{"Operator"}, "", 2*time.Hour, at(4, 10, 0), true)
	ask("Data Science", []string{"Operator"}, "", 0, at(3, 10, 0), true)
	ask("Frontend Dev", []string{"Backend Dev"}, "Backend Dev", 5*time.Minute, at(6, 14, 0), false)
	ask("QA Reviewer 1", []string{"Frontend Dev"}, "Frontend Dev", 15*time.Minute, at(7, 14, 0), false)
	L.OpAsks[2], L.OpSlowest = 3660, 7200     // waits 120 s and 7200 s: the median is their mean, the slowest the longer
	L.AgentAsks[2], L.AgentSlowest = 600, 900 // 300 s and 900 s
	// relays to and from two other boards
	relay := func(from, to string, n int, daysAgo int) {
		for k := 0; k < n; k++ {
			ts := at(daysAgo, 11, k)
			in, out, err := bs.PostCrossTeamMessage(ctx, board.CrossTeamPost{Origin: board.MessageOrigin{ServerID: "local", Board: from, Sender: "Orchestrator", SenderRole: "Orchestrator", TargetServerID: "local", TargetBoard: to}, Content: "relayed note"})
			require.NoError(t, err)
			stamp("board_messages", "id", in.ID, ts)
			stamp("board_messages", "id", out.ID, ts)
			if from == team || to == team {
				L.Cross++
				L.CrossByDay[dayOf(ts)]++
				p := L.Pairs[from+">"+to]
				p[0]++
				L.Pairs[from+">"+to] = p
			}
		}
	}
	relay(team, "coral-hub", 5, 9)
	relay(team, "windows", 3, 8)
	relay("coral-hub", team, 4, 7)
	relay("windows", team, 2, 6)
	relay("coral-hub", "windows", 6, 5) // between two other boards: not this board's traffic
	// goal requests: three to coral-hub (one accepted), one to windows, two in from coral-hub, one in from windows
	goal := func(b string) *board.Goal {
		g, err := bs.CreateGoal(ctx, b, board.GoalInput{Title: "Goal of " + b, CreatedBy: "Orchestrator"})
		require.NoError(t, err)
		return g
	}
	gOurs, gHub, gWin := goal(team), goal("coral-hub"), goal("windows")
	request := func(from string, g *board.Goal, to string, accept bool, daysAgo int) {
		out, in, err := bs.SendGoalRequest(ctx, from, g.ID, to, "please build", "Lead", nil)
		require.NoError(t, err)
		ts := at(daysAgo, 12, 0)
		stamp("board_goal_requests_out", "id", out.ID, ts)
		stamp("board_goal_requests_in", "id", in.ID, ts)
		if accept {
			_, err := bs.ApplyGoalRequestReply(ctx, from, out.RequestID, "", to, "accepted", "")
			require.NoError(t, err)
		}
		k := from + ">" + to
		if from == team || to == team {
			p := L.Pairs[k]
			p[1]++
			if accept {
				p[2]++
			}
			L.Pairs[k] = p
		}
	}
	for i := 0; i < 3; i++ {
		request(team, gOurs, "coral-hub", i == 0, 10-i)
	}
	request(team, gOurs, "windows", false, 4)
	request("coral-hub", gHub, team, false, 3)
	request("coral-hub", gHub, team, false, 2)
	request("windows", gWin, team, false, 1)
	// tasks: 24 created by the Orchestrator for an agent, six by the Operator; 16 of them completed on assorted days
	var created []int64
	for i := 0; i < 30; i++ {
		creator, assignee := "Orchestrator", realisticAgents[1+i%11]
		if i%5 == 4 {
			creator = "Operator"
		}
		task, err := bs.CreateTask(ctx, team, fmt.Sprintf("Task %d", i), "", "medium", creator, assignee)
		require.NoError(t, err)
		created = append(created, task.ID)
		cts := at(12-i%11, 9, 0)
		_, err = bs.Writer().ExecContext(ctx, `UPDATE board_tasks SET created_at = ? WHERE id = ?`, cts.Format(time.RFC3339), task.ID)
		require.NoError(t, err)
		if creator != "Operator" {
			L.Assigned++
		}
		if i%2 == 0 && i < 32 {
			dts := at(11-i%10, 15, 0)
			_, err = bs.Writer().ExecContext(ctx, `UPDATE board_tasks SET status = 'completed', completed_by = ?, completed_at = ? WHERE id = ?`, assignee, dts.Format(time.RFC3339), task.ID)
			require.NoError(t, err)
			L.Done++
			L.DoneByDay[dayOf(dts)]++
		}
	}
	_ = created

	// ---- the read, through the handler, with the clock fixed
	h := NewActivityHandler(bs)
	h.now = func() time.Time { return now }
	rec := httptest.NewRecorder()
	h.Activity(rec, httptest.NewRequest(http.MethodGet, "/api/analytics/activity?team="+team+"&range=14d", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var reply struct {
		Activity board.Activity `json:"activity"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &reply))
	a := reply.Activity

	eq := func(name string, want, got any) { require.Equal(t, want, got, name) }
	eq("agent messages", L.AgentPosts, a.AgentPosts)
	eq("the Operator's posts", L.OperatorPosts, a.OperatorPosts)
	eq("automated notices", L.Automated, a.AutomatedPosts)
	eq("cross-team copies on this board", L.Cross, a.CrossPosts)
	eq("tasks one agent created for another", L.Assigned, a.Assigned)
	eq("tasks done", L.Done, a.TasksDone)
	require.False(t, a.Truncated)
	for _, d := range a.Days {
		eq("posts "+d.Day, L.PostsByDay[d.Day], d.Posts)
		eq("operator "+d.Day, L.OperatorByDay[d.Day], d.Operator)
		eq("automated "+d.Day, L.AutomatedByDay[d.Day], d.Automated)
		eq("cross "+d.Day, L.CrossByDay[d.Day], d.Cross)
		eq("done "+d.Day, L.DoneByDay[d.Day], d.TasksDone)
	}
	sent := 0
	for _, g := range a.Agents {
		eq("sent "+g.Name, L.Sent[g.Name], g.Sent)
		eq("received "+g.Name, L.Received[g.Name], g.Received)
		eq("to the Operator "+g.Name, L.ToOperator[g.Name], g.ToOperator)
		eq("asks of the Operator "+g.Name, L.AsksOperator[g.Name], g.AsksOperator)
		sent += g.Sent
	}
	eq("sent adds up to the posts", L.AgentPosts, sent)
	edges := map[string]int{}
	for _, e := range a.Edges {
		edges[e.From+">"+e.To] = e.Count
	}
	eq("who @mentioned whom", L.Edges, edges)
	eq("asks between agents", L.AgentAsks[:2], []int{a.Asks.Asked, a.Asks.Answered})
	eq("asks of the Operator", L.OpAsks[:2], []int{a.OperatorAsks.Asked, a.OperatorAsks.Answered})
	require.NotNil(t, a.OperatorAsks.MedianS)
	eq("median wait for the Operator", float64(L.OpAsks[2]), *a.OperatorAsks.MedianS)
	eq("slowest wait for the Operator", float64(L.OpSlowest), *a.OperatorAsks.SlowestS)
	eq("median reply between agents", float64(L.AgentAsks[2]), *a.Asks.MedianS)
	pairs := map[string][3]int{}
	for _, p := range a.Pairs {
		pairs[p.From+">"+p.To] = [3]int{p.Messages, p.Requests, p.Accepted}
	}
	eq("team to team", L.Pairs, pairs)
	// the traffic between two other boards is not this board's
	_, other := pairs["coral-hub>windows"]
	require.False(t, other)

	// a direct count in SQL, with nothing of the read's code in it
	count := func(q string, args ...any) int {
		var n int
		require.NoError(t, bs.Reader().GetContext(ctx, &n, q, args...))
		return n
	}
	since, until := a.Since, a.Until
	total := count(`SELECT COUNT(*) FROM board_messages WHERE project = ? AND created_at >= ? AND created_at < ?`, team, since, until)
	eq("every message is in exactly one class", total, a.AgentPosts+a.OperatorPosts+a.AutomatedPosts+a.CrossPosts)
	eq("operator posts, direct", a.OperatorPosts, count(`SELECT COUNT(*) FROM board_messages WHERE project = ? AND subscriber_id = 'Operator' AND created_at >= ? AND created_at < ?`, team, since, until))
	eq("automated, direct", a.AutomatedPosts, count(`SELECT COUNT(*) FROM board_messages WHERE project = ? AND subscriber_id IN ('Coral Task Queue','Coral Health Monitor') AND created_at >= ? AND created_at < ?`, team, since, until))
	eq("cross-team, direct", a.CrossPosts, count(`SELECT COUNT(*) FROM board_messages WHERE project = ? AND external_json IS NOT NULL AND created_at >= ? AND created_at < ?`, team, since, until))
	eq("tasks done, direct", a.TasksDone, count(`SELECT COUNT(*) FROM board_tasks WHERE board_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?`, team, since, until))
	eq("requests, direct", 7, count(`SELECT (SELECT COUNT(*) FROM board_goal_requests_out WHERE board_id = ? AND created_at >= ? AND created_at < ?) + (SELECT COUNT(*) FROM board_goal_requests_in WHERE board_id = ? AND created_at >= ? AND created_at < ?)`, team, since, until, team, since, until))

	// ---- token usage: a month of rows; the daily series' totals against SUM() in SQL
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "usage.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ts := store.NewTokenUsageStore(db)
	tb := team
	usageAgents := realisticAgents[:6]
	var wantCur, wantPrev float64
	var wantTokCur, wantReqCur int
	today := now.Truncate(24 * time.Hour)
	for day := 27; day >= 0; day-- {
		for i, ag := range usageAgents {
			cost := float64(1+rnd(9)) + float64(i)/10
			u := store.TokenUsage{SessionID: "s-" + ag, AgentName: ag, AgentType: "claude", BoardName: &tb, Model: "claude-fable-5-1", InputTokens: 1000 * (1 + rnd(9)), OutputTokens: 300 * (1 + rnd(5)), CacheReadTokens: 5000, TotalTokens: 0, CostUSD: cost, NumTurns: 2, RecordedAt: today.AddDate(0, 0, -day).Add(time.Duration(10+i) * time.Hour).Format(time.RFC3339)}
			u.TotalTokens = u.InputTokens + u.OutputTokens
			require.NoError(t, ts.RecordUsage(ctx, &u))
			if day < 14 {
				wantCur += cost
				wantTokCur += u.InputTokens + u.OutputTokens
				wantReqCur += 1
			} else {
				wantPrev += cost
			}
		}
	}
	sinceDay := today.AddDate(0, 0, -27).Format(time.RFC3339)
	r := chiUsageRouter(db)
	var series struct {
		Buckets []map[string]any `json:"buckets"`
	}
	require.Equal(t, http.StatusOK, seriesGet(t, r, "/api/token-usage/timeseries?since="+sinceDay+"&interval=1d&group_by=agent", false, &series))
	var sumCur, sumPrev float64
	for _, b := range series.Buckets {
		day, _ := time.Parse(time.RFC3339, fmt.Sprint(b["bucket"]))
		if !day.Before(today.AddDate(0, 0, -13)) {
			sumCur += b["cost_usd"].(float64)
		} else {
			sumPrev += b["cost_usd"].(float64)
		}
	}
	require.InDelta(t, wantCur, sumCur, 1e-6, "current 14 days' spend, seed against the daily series")
	require.InDelta(t, wantPrev, sumPrev, 1e-6, "the 14 days before")
	var sqlCur float64
	require.NoError(t, db.GetContext(ctx, &sqlCur, `SELECT COALESCE(SUM(cost_usd), 0) FROM token_usage WHERE recorded_at >= ?`, today.AddDate(0, 0, -13).Format(time.RFC3339)))
	require.InDelta(t, wantCur, sqlCur, 1e-6, "current 14 days' spend, seed against SUM() in SQL")

	if dir := os.Getenv("CORAL_WRITE_FIXTURES"); dir != "" {
		names := make([]string, 0, len(L.Edges))
		for k := range L.Edges {
			names = append(names, k)
		}
		sort.Strings(names)
		fix := map[string]any{
			"today": today.Format("2006-01-02"), "activity": json.RawMessage(rec.Body.Bytes()), "timeseries": series,
			"expect": map[string]any{
				"agent_posts": L.AgentPosts, "operator_posts": L.OperatorPosts, "automated": L.Automated, "cross": L.Cross, "assigned": L.Assigned, "done": L.Done,
				"operator_asks": L.OpAsks, "operator_slowest": L.OpSlowest, "agent_asks": L.AgentAsks,
				"pairs": L.Pairs, "sent": L.Sent, "received": L.Received, "to_operator": L.ToOperator, "edge_count": len(names),
				"usage": map[string]any{"cost_cur": wantCur, "cost_prev": wantPrev, "tokens_cur": wantTokCur, "requests_cur": wantReqCur},
			},
		}
		b, err := json.MarshalIndent(fix, "", " ")
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "analytics_realistic.json"), b, 0o644))
	}
	_ = strings.TrimSpace
}

func chiUsageRouter(db *store.DB) http.Handler {
	h := NewTokenUsageHandler(db)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/token-usage/timeseries", h.UsageTimeSeries)
	return mux
}
