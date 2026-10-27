package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #9596: hostile query parameters and ids on the board reads whose SQL changed on Oct 27 evening (#9556 the tasks list, #9560 the task detail, #9584 the goals list, #9535 and #9594 the artifacts
// list). Every answer is a 200 with a JSON body or a 4xx, never a 5xx; and on valid input the rows are the ones the test seeded (a model of the seed, not the store's own code): the same tasks
// in the order the list documents, every page of the cursor walk once, the goals by state, the artifacts newest first.

var (
	rdStatuses = []string{"", "open", "completed", "all", "OPEN", "done", "pending", "open,completed", "open;all", "all\x00", "'; DROP TABLE board_tasks; --", "%", "_", strings.Repeat("a", 5000), "😀", " open", "open "}
	rdCursors  = []string{"", "x", "p", "d", "p:1", "d:1:2", "cDoxOjE", "eyJhIjoxfQ", "!!!!", "%00", "../", strings.Repeat("A", 3000), "cDo6Og==", "p:0:0", "p:high:-1", "p:high:99999999999999999999", "d:2026-10-27T00:00:00Z:1", "😀"}
	rdLimits   = []string{"", "0", "-1", "1", "7", "200", "201", "500", "501", "100000", "9223372036854775807", "9223372036854775808", "99999999999999999999", "1.5", "1e3", "0x10", " 5", "5 ", "+5", "x", "'", "\x00", "NaN", strings.Repeat("9", 400)}
	rdInts     = []string{"", "0", "1", "-1", "999999999", "9223372036854775807", "9223372036854775808", "x", "1.5", "'", "\x00", " 3", "3 ", "+3", "1e2", strings.Repeat("9", 400)}
	rdText     = []string{"", "alpha", "dev", "%", "_", "'", "\"", "' OR 1=1 --", "\\", strings.Repeat("a", 5000), "\x00", "😀", "a\nb", "../../etc/passwd", "ALPHA", "al%", "a,b", "a&b=c", "\u202e"}
	rdStates   = []string{"", "active", "proposed", "done", "dropped", "blocked", "active,done", "active,", ",", ",,,", "ACTIVE", "nope", "active,nope", "'; --", "\x00", strings.Repeat("active,", 400), "😀", " active", "active "}
	rdFlags    = []string{"", "1", "0", "true", "false", "TRUE", "yes", "-1", "x", "\x00", "1&full=1", strings.Repeat("1", 500)}
	rdTimes    = []string{"", "soon", "2026-13-45T99:99:99Z", "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "99999-01-01T00:00:00Z", "2026-10-27", "2026-10-27T12:00:00Z", "1e9", "-1", "'; --", "\x00", strings.Repeat("9", 300)}
	rdSorts    = []string{"", "id", "created", "updated", "priority", "-id", "id desc", "id;drop", "\x00", "name", "cost"}
	rdIDs      = []string{"0", "1", "-1", "2", "999999999", "9223372036854775807", "9223372036854775808", "99999999999999999999", "x", "1.5", "1e2", "0x10", "%20", "+3", "٣", "😀", "1;2", "1'", "..", strings.Repeat("9", 400), "\x00"}
	rdProjects = []string{"b9596", "B9596", "no-such-board", "..", "../b9596", "b9596/../b9596", "%00", "' OR 1=1 --", "%", "_", "*", "\\", "😀", "b 9596", " b9596", strings.Repeat("b", 5000), "projects", "tasks"}
)

type readsEnv struct {
	t   *testing.T
	srv string
	h   *BoardHandler
	bs  *board.Store
}

func newReadsEnv(t *testing.T) *readsEnv {
	t.Helper()
	srv, h, _ := teamArtifactServer(t)
	// the artifact server routes the artifact reads; the others are added on a second router over the same handler
	r := chi.NewRouter()
	r.Get("/api/board/{project}/tasks", h.ListTasks)
	r.Get("/api/board/{project}/tasks/{taskID}", h.GetTask)
	r.Get("/api/board/tasks", h.ListAllTasks)
	r.Get("/api/board/{project}/goals", h.ListGoals)
	r.Get("/api/goals", h.ListAllGoals)
	r.Get("/api/board/{project}/artifacts", h.ListTeamArtifacts)
	r.Get("/api/team-artifacts", h.ListAllTeamArtifacts)
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	_ = srv
	return &readsEnv{t: t, srv: ts.URL, h: h, bs: h.bs}
}

func (e *readsEnv) get(path string, q url.Values) (int, []byte) {
	e.t.Helper()
	target := e.srv + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	resp, err := http.Get(target)
	require.NoError(e.t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// seed makes a board of 60 tasks in every state the list tells apart, two goals' worth of tasks, and artifacts on the completed ones. It returns the model: ids by state.
type readsSeed struct {
	open, done, all []int64 // by id
	byPriority      map[string][]int64
	goalA, goalB    int64
	goalATasks      []int64
	goalADone       int // of goalATasks, completed
	parent          int64
	followUps       []int64 // the tasks made from parent, oldest first
	parent2         int64   // another parent, with one follow-up
	followUps2      []int64
	artifactTasks   []int64
}

func (e *readsEnv) seed(project string) readsSeed {
	t, bs := e.t, e.bs
	ctx := context.Background()
	rng := rand.New(rand.NewSource(9596))
	prios := []string{"critical", "high", "medium", "low"}
	var s readsSeed
	s.byPriority = map[string][]int64{}
	gA, err := bs.CreateGoal(ctx, project, board.GoalInput{Title: "Goal A", Outcome: "o", DoneWhen: "d", CreatedBy: "lead"})
	require.NoError(t, err)
	gB, err := bs.CreateGoal(ctx, project, board.GoalInput{Title: "Goal B", Outcome: "o", DoneWhen: "d", CreatedBy: "lead", State: "proposed"})
	require.NoError(t, err)
	s.goalA, s.goalB = gA.ID, gB.ID
	for i := 0; i < 60; i++ {
		p := prios[rng.Intn(len(prios))]
		opts := &board.CreateTaskOpts{}
		switch {
		case i%7 == 3:
			opts.Draft = true
		case i%5 == 0:
			opts.GoalID = &s.goalA
		}
		task, err := bs.CreateTaskWithOpts(ctx, project, fmt.Sprintf("task %d", i), "body", p, "lead", opts)
		require.NoError(t, err)
		if i%4 == 1 && !opts.Draft { // completed (a draft is not workable), some with artifacts
			arts := []board.TaskArtifact(nil)
			if i%8 == 1 {
				arts = []board.TaskArtifact{{Name: fmt.Sprintf("notes-%d", i), Content: fmt.Sprintf("inline notes %d", i)}}
				s.artifactTasks = append(s.artifactTasks, task.ID)
			}
			_, err = bs.CompleteTaskWithArtifacts(ctx, project, task.ID, "lead", nil, "success", arts)
			require.NoError(t, err)
			s.done = append(s.done, task.ID)
		} else {
			s.open = append(s.open, task.ID)
			s.byPriority[p] = append(s.byPriority[p], task.ID)
		}
		s.all = append(s.all, task.ID)
		if opts.GoalID != nil {
			s.goalATasks = append(s.goalATasks, task.ID)
			if i%4 == 1 && !opts.Draft {
				s.goalADone++
			}
		}
	}
	// three follow-ups of one task (task add --follow-up): the detail of the parent lists them, oldest first (#9560 reads them from lst_parent)
	s.parent = s.open[0]
	for i := 0; i < 3; i++ {
		f, err := bs.CreateTaskWithOpts(ctx, project, fmt.Sprintf("follow-up %d", i), "", "medium", "lead", &board.CreateTaskOpts{Workflow: board.TaskWorkflow{ParentTaskID: s.parent}})
		require.NoError(t, err)
		s.followUps = append(s.followUps, f.ID)
		s.open = append(s.open, f.ID)
		s.all = append(s.all, f.ID)
		s.byPriority["medium"] = append(s.byPriority["medium"], f.ID)
	}
	s.parent2 = s.open[1]
	f2, err := bs.CreateTaskWithOpts(ctx, project, "follow-up of another", "", "medium", "lead", &board.CreateTaskOpts{Workflow: board.TaskWorkflow{ParentTaskID: s.parent2}})
	require.NoError(t, err)
	s.followUps2 = []int64{f2.ID}
	s.open, s.all = append(s.open, f2.ID), append(s.all, f2.ID)
	s.byPriority["medium"] = append(s.byPriority["medium"], f2.ID)
	return s
}

func rank(p string) int {
	switch p {
	case "critical":
		return 0
	case "high":
		return 1
	case "medium":
		return 2
	case "low":
		return 3
	}
	return 4
}

type taskListReply struct {
	Tasks []struct {
		ID          int64  `json:"id"`
		Priority    string `json:"priority"`
		Status      string `json:"status"`
		CompletedAt string `json:"completed_at"`
	} `json:"tasks"`
	NextCursor     string `json:"next_cursor"`
	TotalOpen      int    `json:"total_open"`
	TotalCompleted int    `json:"total_completed"`
}

func TestBoardReadsNeverFiveHundredOnHostileParams(t *testing.T) {
	e := newReadsEnv(t)
	const project = "b9596"
	seed := e.seed(project)
	rng := rand.New(rand.NewSource(95961))
	pick := func(vs []string) string { return vs[rng.Intn(len(vs))] }
	checked, ok200, refused := 0, 0, 0
	check := func(path string, q url.Values) {
		t.Helper()
		code, body := e.get(path, q)
		checked++
		require.Less(t, code, 500, "%s %q: %s", path[:min(len(path), 120)], q.Encode()[:min(len(q.Encode()), 240)], string(body[:min(len(body), 300)]))
		switch {
		case code == 200:
			ok200++
			var any json.RawMessage
			require.NoError(t, json.Unmarshal(body, &any), "%s: a 200 is JSON", path)
		default:
			refused++
		}
	}
	tasks := "/api/board/" + project + "/tasks"
	// each parameter of the board's task list alone, hostile; then random mixes
	for _, v := range rdStatuses {
		check(tasks, url.Values{"status": {v}})
	}
	for _, v := range rdCursors {
		check(tasks, url.Values{"cursor": {v}})
		for _, st := range []string{"open", "completed", "all"} {
			check(tasks, url.Values{"cursor": {v}, "status": {st}})
		}
	}
	for _, v := range rdLimits {
		check(tasks, url.Values{"limit": {v}})
		check(tasks, url.Values{"limit": {v}, "status": {"all"}})
	}
	for _, v := range rdInts {
		check(tasks, url.Values{"goal": {v}})
		check(tasks, url.Values{"goal": {v}, "limit": {"3"}})
		check(tasks, url.Values{"goal": {v}, "full": {"1"}})
	}
	for _, v := range rdFlags {
		check(tasks, url.Values{"needs_review": {v}})
		check(tasks, url.Values{"counts": {v}})
		check(tasks, url.Values{"full": {v}})
	}
	for i := 0; i < 600; i++ {
		q := url.Values{}
		for k, vs := range map[string][]string{"status": rdStatuses, "cursor": rdCursors, "limit": rdLimits, "goal": rdInts, "needs_review": rdFlags, "counts": rdFlags, "full": rdFlags, "assignee": rdText, "offset": rdInts} {
			if rng.Intn(3) == 0 {
				q.Set(k, pick(vs))
			}
		}
		check(tasks, q)
	}
	// the Operator's all-boards list and its query parameters (assigned_to, board, priority, created_by, since, sort, order, limit, cursor, q, id, goal_id, ...)
	for _, k := range []string{"fields", "status", "assigned_to", "assignee", "board", "priority", "created_by", "verification", "parked", "created_since", "updated_since", "sort", "order", "limit", "offset", "cursor", "q", "id", "goal_id"} {
		for _, v := range append(append(append([]string{}, rdText...), rdStatuses...), rdInts...) {
			check("/api/board/tasks", url.Values{k: {v}})
		}
	}
	for i := 0; i < 400; i++ {
		check("/api/board/tasks", url.Values{"status": {pick(rdStatuses)}, "limit": {pick(rdLimits)}, "cursor": {pick(rdCursors)}, "q": {pick(rdText)}, "sort": {pick(rdSorts)}, "assigned_to": {pick(rdText)}, "goal_id": {pick(rdInts)}, "created_since": {pick(rdTimes)}})
	}
	// the task detail: every hostile id, version, project
	for _, id := range rdIDs {
		check(tasks+"/"+url.PathEscape(id), nil)
		for _, v := range rdInts {
			check(tasks+"/"+url.PathEscape(id), url.Values{"version": {v}})
		}
	}
	for _, p := range rdProjects {
		check("/api/board/"+url.PathEscape(p)+"/tasks/1", nil)
		check("/api/board/"+url.PathEscape(p)+"/tasks", url.Values{"status": {"all"}})
		check("/api/board/"+url.PathEscape(p)+"/goals", nil)
		check("/api/board/"+url.PathEscape(p)+"/artifacts", nil)
	}
	// the goals lists
	goals := "/api/board/" + project + "/goals"
	for _, v := range rdStates {
		check(goals, url.Values{"state": {v}})
		check("/api/goals", url.Values{"state": {v}})
	}
	for _, v := range rdLimits {
		check(goals, url.Values{"limit": {v}})
		check("/api/goals", url.Values{"limit": {v}})
	}
	for _, v := range rdCursors {
		check(goals, url.Values{"cursor": {v}})
		check("/api/goals", url.Values{"cursor": {v}})
	}
	for _, v := range rdText {
		check("/api/goals", url.Values{"board": {v}})
		check("/api/goals", url.Values{"board": {v, "b9596"}})
	}
	for i := 0; i < 300; i++ {
		check(goals, url.Values{"state": {pick(rdStates)}, "limit": {pick(rdLimits)}, "cursor": {pick(rdCursors)}})
		check("/api/goals", url.Values{"state": {pick(rdStates)}, "limit": {pick(rdLimits)}, "cursor": {pick(rdCursors)}, "board": {pick(rdText)}})
	}
	// the artifacts lists: every parameter the list names, hostile
	arts := "/api/board/" + project + "/artifacts"
	names := []string{"limit", "offset", "session_id", "q", "kind", "origin", "by", "board", "kept", "task", "goal", "tag", "since", "until", "sort", "cursor"}
	pool := append(append(append(append([]string{}, rdText...), rdLimits...), rdTimes...), rdSorts...)
	for _, k := range names {
		for _, v := range pool {
			check(arts, url.Values{k: {v}})
			check("/api/team-artifacts", url.Values{k: {v}})
		}
	}
	for i := 0; i < 500; i++ {
		q := url.Values{}
		for _, k := range names {
			if rng.Intn(3) == 0 {
				q.Set(k, pick(pool))
			}
		}
		check(arts, q)
		check("/api/team-artifacts", q)
	}
	_ = seed
	assert.Greater(t, ok200, 800, "most calls are answered")
	assert.Greater(t, refused, 800, "and the invalid ones are refused")
	t.Logf("%d hostile requests: %d answered 200, %d refused with a 4xx, none a 5xx", checked, ok200, refused)
}

// On valid input the board's task list is the seeded tasks, in the order the list documents, and a walk of its cursors reads every one once at any page size.
func TestBoardTaskListMatchesTheSeededModel(t *testing.T) {
	e := newReadsEnv(t)
	const project = "b9596"
	seed := e.seed(project)
	tasks := "/api/board/" + project + "/tasks"
	walk := func(status string, limit int) (ids []int64, totals [2]int) {
		cursor := ""
		for page := 0; page < 400; page++ {
			q := url.Values{}
			if status != "" {
				q.Set("status", status)
			}
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			code, body := e.get(tasks, q)
			require.Equal(t, 200, code, "%s %s: %s", status, q.Encode(), body)
			var r taskListReply
			require.NoError(t, json.Unmarshal(body, &r))
			for _, tk := range r.Tasks {
				ids = append(ids, tk.ID)
			}
			totals = [2]int{r.TotalOpen, r.TotalCompleted}
			if r.NextCursor == "" {
				return ids, totals
			}
			require.NotEqual(t, cursor, r.NextCursor, "the cursor moves")
			cursor = r.NextCursor
		}
		t.Fatalf("%s limit %d: the cursor walk did not end", status, limit)
		return nil, totals
	}
	sortedCopy := func(a []int64) []int64 {
		b := append([]int64{}, a...)
		sort.Slice(b, func(i, j int) bool { return b[i] < b[j] })
		return b
	}
	newestFirst := func(a []int64) []int64 {
		b := sortedCopy(a)
		for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
			b[i], b[j] = b[j], b[i]
		}
		return b
	}
	openByPriorityThenID := func() []int64 {
		var out []int64
		for _, p := range []string{"critical", "high", "medium", "low"} {
			out = append(out, sortedCopy(seed.byPriority[p])...)
		}
		return out
	}()
	for _, limit := range []int{0, 1, 2, 7, 25, 50, 200} {
		// open and all: by id
		got, totals := walk("open", limit)
		assert.Equal(t, sortedCopy(seed.open), got, "status=open limit %d: every open task, oldest id first, once", limit)
		assert.Equal(t, [2]int{len(seed.open), len(seed.done)}, totals, "the totals are the board's")
		got, _ = walk("all", limit)
		assert.Equal(t, newestFirst(seed.all), got, "status=all limit %d: every task, newest id first, once", limit)
		// completed: every done task once, newest first
		got, _ = walk("completed", limit)
		assert.ElementsMatch(t, seed.done, got, "status=completed limit %d: every done task once", limit)
		assert.Len(t, got, len(seed.done))
		// the default list: the open tasks by priority then id, then the done tasks
		got, _ = walk("", limit)
		require.Len(t, got, len(seed.all), "default list limit %d: every task once", limit)
		assert.Equal(t, openByPriorityThenID, got[:len(seed.open)], "default list limit %d: the open tasks by priority, then id", limit)
		assert.ElementsMatch(t, seed.done, got[len(seed.open):], "default list limit %d: then the done tasks", limit)
	}
	// the counts alone, and a goal's tasks
	code, body := e.get(tasks, url.Values{"counts": {"1"}})
	require.Equal(t, 200, code)
	var c taskListReply
	require.NoError(t, json.Unmarshal(body, &c))
	assert.Equal(t, [2]int{len(seed.open), len(seed.done)}, [2]int{c.TotalOpen, c.TotalCompleted})
	assert.Empty(t, c.Tasks)
	for _, limit := range []int{1, 3, 50} {
		var ids []int64
		cursor := ""
		for page := 0; page < 100; page++ {
			q := url.Values{"goal": {strconv.FormatInt(seed.goalA, 10)}, "limit": {strconv.Itoa(limit)}}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			code, body := e.get(tasks, q)
			require.Equal(t, 200, code, string(body))
			var r taskListReply
			require.NoError(t, json.Unmarshal(body, &r))
			for _, tk := range r.Tasks {
				ids = append(ids, tk.ID)
			}
			if r.NextCursor == "" {
				break
			}
			cursor = r.NextCursor
		}
		assert.ElementsMatch(t, seed.goalATasks, ids, "goal=%d limit %d: the goal's tasks, once each", seed.goalA, limit)
	}
	// the task detail: every seeded task, and the ids that are not tasks
	for _, id := range seed.all {
		code, body := e.get(tasks+"/"+strconv.FormatInt(id, 10), nil)
		require.Equal(t, 200, code, "task %d", id)
		var d struct {
			ID    int64  `json:"id"`
			Title string `json:"title"`
		}
		require.NoError(t, json.Unmarshal(body, &d))
		assert.Equal(t, id, d.ID)
	}
	for _, c := range []struct {
		parent int64
		want   []int64
	}{{seed.parent, seed.followUps}, {seed.parent2, seed.followUps2}} {
		code, body = e.get(tasks+"/"+strconv.FormatInt(c.parent, 10), nil)
		require.Equal(t, 200, code)
		var parent struct {
			FollowUps []struct {
				ID int64 `json:"id"`
			} `json:"follow_ups"`
		}
		require.NoError(t, json.Unmarshal(body, &parent))
		var gotFollow []int64
		for _, f := range parent.FollowUps {
			gotFollow = append(gotFollow, f.ID)
		}
		assert.Equal(t, c.want, gotFollow, "task %d's detail lists its own follow-ups, oldest first", c.parent)
	}
	// known (LOW, #9596): GetTask answers 404 "task not found" for ANY store error, not only a missing task, so a damaged database looks like a missing task here, not a 500; fine for now (Orchestrator, 21:26)
	for _, bad := range []string{"0", "-1", "999999", "x"} {
		code, _ := e.get(tasks+"/"+bad, nil)
		assert.GreaterOrEqual(t, code, 400)
		assert.Less(t, code, 500, bad)
	}
}

// checkRollup: the goals list's rollup of Goal A is its tasks by what they are doing, as the seed made them (#9584 counts the page's goals only, on a covering index).
func checkRollup(t *testing.T, e *readsEnv, goals string, seed readsSeed) {
	t.Helper()
	code, body := e.get(goals, nil)
	require.Equal(t, 200, code)
	var r struct {
		Goals []struct {
			ID     int64            `json:"id"`
			Rollup board.GoalRollup `json:"rollup"`
		} `json:"goals"`
	}
	require.NoError(t, json.Unmarshal(body, &r))
	for _, g := range r.Goals {
		if g.ID == seed.goalA {
			assert.Equal(t, board.GoalRollup{Done: seed.goalADone, Queued: len(seed.goalATasks) - seed.goalADone, Total: len(seed.goalATasks)}, g.Rollup, "Goal A's rollup is its tasks as seeded")
		}
		if g.ID == seed.goalB {
			assert.Equal(t, board.GoalRollup{}, g.Rollup, "Goal B has no tasks")
		}
	}
}

// The goals list is the seeded goals, by id, filtered by state, at every page size; and the artifacts list is the completed tasks' artifacts, newest first, once each.
func TestBoardGoalsAndArtifactsListsMatchTheSeededModel(t *testing.T) {
	e := newReadsEnv(t)
	const project = "b9596"
	seed := e.seed(project)
	goals := "/api/board/" + project + "/goals"
	type goalRow struct {
		ID    int64  `json:"id"`
		State string `json:"state"`
	}
	read := func(q url.Values) (ids []int64, states []string) {
		cursor := ""
		for page := 0; page < 50; page++ {
			qq := url.Values{}
			for k, v := range q {
				qq[k] = v
			}
			if cursor != "" {
				qq.Set("cursor", cursor)
			}
			code, body := e.get(goals, qq)
			require.Equal(t, 200, code, "%s: %s", qq.Encode(), body)
			var r struct {
				Goals      []goalRow `json:"goals"`
				NextCursor string    `json:"next_cursor"`
			}
			require.NoError(t, json.Unmarshal(body, &r))
			for _, g := range r.Goals {
				ids, states = append(ids, g.ID), append(states, g.State)
			}
			if r.NextCursor == "" {
				return
			}
			cursor = r.NextCursor
		}
		t.Fatalf("%s: the goal cursor walk did not end", q.Encode())
		return
	}
	for _, limit := range []string{"", "1", "2"} {
		q := url.Values{}
		if limit != "" {
			q.Set("limit", limit)
		}
		ids, _ := read(q)
		assert.Equal(t, []int64{seed.goalA, seed.goalB}, ids, "every goal, by id (limit %q)", limit)
		checkRollup(t, e, goals, seed)
		q.Set("state", "active")
		ids, states := read(q)
		assert.Equal(t, []int64{seed.goalA}, ids, "state=active: Goal A alone (limit %q)", limit)
		assert.Equal(t, []string{"active"}, states)
		q.Set("state", "proposed")
		ids, _ = read(q)
		assert.Equal(t, []int64{seed.goalB}, ids, "state=proposed: Goal B alone (limit %q)", limit)
		q.Set("state", "active,proposed")
		ids, _ = read(q)
		assert.Equal(t, []int64{seed.goalA, seed.goalB}, ids, "both states (limit %q)", limit)
		q.Set("state", "done")
		ids, _ = read(q)
		assert.Empty(t, ids, "no goal is done (limit %q)", limit)
	}
	// the artifacts: one per artifact task, newest first, once each, at every page size
	arts := "/api/board/" + project + "/artifacts"
	var all []string
	for _, limit := range []int{1, 2, 3, 100} {
		var got []string
		for offset := 0; offset < 100; offset += limit {
			code, body := e.get(arts, url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}})
			require.Equal(t, 200, code, string(body))
			var r struct {
				Artifacts []struct {
					Name   string `json:"name"`
					TaskID int64  `json:"task_id"`
				} `json:"artifacts"`
				HasMore bool `json:"has_more"`
			}
			require.NoError(t, json.Unmarshal(body, &r))
			for _, a := range r.Artifacts {
				got = append(got, fmt.Sprintf("%d:%s", a.TaskID, a.Name))
			}
			if !r.HasMore {
				break
			}
		}
		if all == nil {
			all = got
		}
		assert.Equal(t, all, got, "limit %d: the pages add up to the one list", limit)
	}
	assert.Len(t, all, len(seed.artifactTasks), "one inline artifact per artifact task")
	want := map[string]bool{}
	for _, id := range seed.artifactTasks {
		for _, g := range all {
			if strings.HasPrefix(g, strconv.FormatInt(id, 10)+":") {
				want[g] = true
			}
		}
	}
	assert.Len(t, want, len(seed.artifactTasks), "each artifact task has its artifact in the list")
	// the task query path of the list (any of kind, q, by, task, sort, cursor: #9594 reads the references from lst_art_refs): the same artifacts, found by task and by name, and the cursor walk of the
	// newest-first and oldest-first lists is the list the offset pages made
	type artRow struct {
		Name   string `json:"name"`
		TaskID int64  `json:"task_id"`
	}
	readArts := func(q url.Values) (rows []artRow, next string) {
		code, body := e.get(arts, q)
		require.Equal(t, 200, code, "%s: %s", q.Encode(), body)
		var r struct {
			Artifacts  []artRow `json:"artifacts"`
			NextCursor string   `json:"next_cursor"`
		}
		require.NoError(t, json.Unmarshal(body, &r))
		return r.Artifacts, r.NextCursor
	}
	for _, id := range seed.artifactTasks {
		rows, _ := readArts(url.Values{"task": {strconv.FormatInt(id, 10)}})
		require.Len(t, rows, 1, "task=%d holds one artifact", id)
		assert.Equal(t, id, rows[0].TaskID)
		byName, _ := readArts(url.Values{"q": {rows[0].Name}})
		require.Len(t, byName, 1, "q=%s finds the one artifact", rows[0].Name)
		assert.Equal(t, id, byName[0].TaskID)
	}
	for _, sortBy := range []string{"newest", "oldest"} {
		for _, limit := range []string{"1", "2", "3"} {
			var got []string
			cursor := ""
			for page := 0; page < 30; page++ {
				q := url.Values{"by": {"lead"}, "sort": {sortBy}, "limit": {limit}}
				if cursor != "" {
					q.Set("cursor", cursor)
				}
				rows, next := readArts(q)
				for _, r := range rows {
					got = append(got, fmt.Sprintf("%d:%s", r.TaskID, r.Name))
				}
				if next == "" {
					break
				}
				cursor = next
			}
			assert.ElementsMatch(t, all, got, "sort=%s limit=%s: the cursor walk reads every artifact once", sortBy, limit)
			assert.Len(t, got, len(all))
		}
	}
}

// A page is at most board.TaskListMaxLimit tasks however large a limit asks for (and the default size when none is asked): a board bigger than a page answers a page and a cursor.
func TestBoardTaskListPageIsCapped(t *testing.T) {
	e := newReadsEnv(t)
	const project = "b9596cap"
	ctx := context.Background()
	n := board.TaskListMaxLimit + 40
	for i := 0; i < n; i++ {
		_, err := e.bs.CreateTask(ctx, project, fmt.Sprintf("task %d", i), "", "medium", "lead")
		require.NoError(t, err)
	}
	for _, limit := range []string{strconv.Itoa(board.TaskListMaxLimit), strconv.Itoa(board.TaskListMaxLimit + 1), "100000", "9223372036854775807"} {
		code, body := e.get("/api/board/"+project+"/tasks", url.Values{"status": {"all"}, "limit": {limit}})
		require.Equal(t, 200, code, limit)
		var r taskListReply
		require.NoError(t, json.Unmarshal(body, &r))
		assert.Len(t, r.Tasks, board.TaskListMaxLimit, "limit=%s is one page of at most %d", limit, board.TaskListMaxLimit)
		assert.NotEmpty(t, r.NextCursor, "limit=%s: the board has more", limit)
	}
}
