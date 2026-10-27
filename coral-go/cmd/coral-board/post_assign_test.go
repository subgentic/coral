package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// assignServer stands in for the board: the poster's current task (current), the tasks it holds by id, and a record of the tasks and messages created.
type assignServer struct {
	*httptest.Server
	mu       sync.Mutex
	current  map[string]any // POST /tasks/current answers this (nil: 404)
	tasks    map[int64]map[string]any
	created  []map[string]any
	messages []map[string]any
}

func newAssignServer(t *testing.T) *assignServer {
	s := &assignServer{tasks: map[int64]map[string]any{}}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/board/team/tasks/current":
			if s.current == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(s.current)
		case r.Method == http.MethodPost && r.URL.Path == "/api/board/team/tasks":
			s.created = append(s.created, body)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":900,"goal_id":` + goalOf(body) + `}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/board/team/messages":
			s.messages = append(s.messages, body)
			_, _ = w.Write([]byte(`{"id":901}`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/board/team/tasks/"):
			var id int64
			for _, c := range strings.TrimPrefix(r.URL.Path, "/api/board/team/tasks/") {
				id = id*10 + int64(c-'0')
			}
			if task, ok := s.tasks[id]; ok {
				_ = json.NewEncoder(w).Encode(task)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func goalOf(body map[string]any) string {
	if g, ok := body["goal_id"]; ok {
		b, _ := json.Marshal(g)
		return string(b)
	}
	return "null"
}

// setCurrent, setTask, createdTasks and sentMessages read and write what the handler reads and appends, under its lock: the handler runs on the server's goroutines.
func (s *assignServer) setCurrent(m map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = m
}

func (s *assignServer) setTask(id int64, m map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks[id] = m
}

func (s *assignServer) createdTasks() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.created...)
}

func (s *assignServer) sentMessages() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.messages...)
}

func (s *assignServer) counts() (tasks, messages int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.created), len(s.messages)
}

// #7791, goal #21: post --assign makes the post a task (the text its body, the first line its title, the assignee, a goal) and posts the text with the task's link.
func TestPostAssignCreatesTheTaskAndPostsItsLink(t *testing.T) {
	srv := newAssignServer(t)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--assign", "Backend Dev", "--goal", "7", "--priority", "high", "Fix the flaky test\nIt fails one run in ten under load.")
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, srv.createdTasks(), 1)
	task := srv.createdTasks()[0]
	assert.Equal(t, "Fix the flaky test", task["title"], "the first line is the title")
	assert.Equal(t, "Fix the flaky test\nIt fails one run in ten under load.", task["body"], "the post is the body")
	assert.Equal(t, "Backend Dev", task["assigned_to"])
	assert.EqualValues(t, 7, task["goal_id"])
	assert.Equal(t, "high", task["priority"])
	assert.Equal(t, "Tester", task["subscriber_id"], "the poster is the creator")
	require.Len(t, srv.sentMessages(), 2, "the server checks the post first (dry_run), then the post is made")
	assert.Equal(t, true, srv.sentMessages()[0]["dry_run"])
	assert.NotContains(t, srv.sentMessages()[1], "dry_run")
	msg := srv.sentMessages()[1]
	assert.EqualValues(t, 900, msg["task_id"], "the post is on the task")
	content, _ := msg["content"].(string)
	assert.Contains(t, content, "Fix the flaky test\nIt fails one run in ten under load.")
	assert.Contains(t, content, "Task #900, assigned to Backend Dev")
	assert.NotContains(t, content, "@", "no @mention: the assignee gets the task notification, not a second nudge")
	assert.Contains(t, res.stdout, "Created Task #900: Fix the flaky test (goal #7, assigned to Backend Dev)")
	assert.Contains(t, res.stdout, "Message #901 posted")
}

func TestPostAssignTakesTheGoalOfThePostersOwnTask(t *testing.T) {
	srv := newAssignServer(t)
	srv.setCurrent(map[string]any{"id": 5, "goal_id": 21})
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--assign", "QA Engineer", "--title", "Review the patch", "Please review coral://artifacts/abc.")
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, srv.createdTasks(), 1)
	assert.EqualValues(t, 21, srv.createdTasks()[0]["goal_id"], "the goal of the poster's in-progress task")
	assert.Equal(t, "Review the patch", srv.createdTasks()[0]["title"], "--title wins over the first line")
	assert.Equal(t, "medium", srv.createdTasks()[0]["priority"])

	// an explicit --goal wins over the task's
	res = runBoard(t, srv.URL, dir, "post", "--assign", "QA Engineer", "--goal", "3", "Second job")
	require.Equal(t, 0, res.code, res.stderr)
	assert.EqualValues(t, 3, srv.createdTasks()[1]["goal_id"])
}

func TestPostAssignWithNoGoalRefusesAndCreatesNothing(t *testing.T) {
	srv := newAssignServer(t) // the poster has no task in progress
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "post", "--assign", "Backend Dev", "Fix the flake")
	assert.Equal(t, 1, res.code)
	assert.Contains(t, res.stderr, "no goal")
	assert.Contains(t, res.stderr, "Nothing was created or posted")
	tasks, msgs := srv.counts()
	assert.Zero(t, tasks+msgs, "no guess: nothing was made")

	srv.setCurrent(map[string]any{"id": 5}) // a task on no goal is no goal either
	res = runBoard(t, srv.URL, dir, "post", "--assign", "Backend Dev", "Fix the flake")
	assert.Equal(t, 1, res.code)
	tasks, msgs = srv.counts()
	assert.Zero(t, tasks+msgs)
}

func TestPostAssignRefusesWhatWouldNudgeTwiceOrIsMalformed(t *testing.T) {
	srv := newAssignServer(t)
	dir := subscribedDataDir(t, srv.URL)
	for name, args := range map[string][]string{
		"@mention of the assignee":    {"post", "--assign", "Backend Dev", "--goal", "1", "@Backend Dev please fix it"},
		"mention inside the text":     {"post", "--assign", "Backend Dev", "--goal", "1", "Please ask @backend dev about it"},
		"--to the assignee":           {"post", "--assign", "Backend Dev", "--goal", "1", "--to", "Lead,backend dev", "Fix it"},
		"a priority that is not one":  {"post", "--assign", "Backend Dev", "--goal", "1", "--priority", "urgent", "Fix it"},
		"a goal that is not a number": {"post", "--assign", "Backend Dev", "--goal", "x", "Fix it"},
		"--goal 0":                    {"post", "--assign", "Backend Dev", "--goal", "0", "Fix it"},
		"no text":                     {"post", "--assign", "Backend Dev", "--goal", "1", " "},
		"--task as well":              {"post", "--assign", "Backend Dev", "--goal", "1", "--task", "4", "Fix it"},
	} {
		res := runBoard(t, srv.URL, dir, args...)
		assert.NotZero(t, res.code, "%s: %q", name, res.stderr)
	}
	tasks, msgs := srv.counts()
	assert.Zero(t, tasks+msgs, "every refusal created and posted nothing")

	// another name is no mention of the assignee
	res := runBoard(t, srv.URL, dir, "post", "--assign", "Backend Dev", "--goal", "1", "Tell @Lead when it is done")
	assert.Zero(t, res.code, res.stderr)
	// --goal, --title and --priority only mean something with --assign
	res = runBoard(t, srv.URL, dir, "post", "--goal", "1", "a plain post")
	assert.Equal(t, 2, res.code)
	assert.Contains(t, res.stderr, "for --assign")
}

func TestPostAssignLongFirstLineMakesAShortTitle(t *testing.T) {
	srv := newAssignServer(t)
	dir := subscribedDataDir(t, srv.URL)
	long := strings.Repeat("word ", 40)
	res := runBoard(t, srv.URL, dir, "post", "--assign", "Backend Dev", "--goal", "1", long)
	require.Equal(t, 0, res.code, res.stderr)
	title, _ := srv.createdTasks()[0]["title"].(string)
	assert.LessOrEqual(t, len([]rune(title)), maxAssignTitle)
	assert.True(t, strings.HasSuffix(title, "…"))
}
