package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7296 (UI/UX #7249 finding 6): an agent learns the board's goals without being told. task add with no --goal, on a board with open goals, says so in one line (the goals, and how to link the task);
// join, the agent's first look at a board, lists the open goals with what makes each done.
const twoGoals = `{"goals":[{"id":3,"title":"Ship the goals page","state":"active","done_when":"The page is in a release"},{"id":5,"title":"Cut the build time","state":"blocked","blocked_on":"the operator"}],"next_cursor":""}`

func TestTaskAddWithNoGoalNamesTheBoardsOpenGoals(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("POST /api/board/team/tasks", `{"id":9,"title":"Fix it"}`)
	gs.setReply("GET /api/board/team/goals", twoGoals)
	res := goalRun(t, gs, "task", "add", "Fix it")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "Created Task #9: Fix it")
	var hint []string
	for _, l := range strings.Split(res.stdout, "\n") {
		if strings.Contains(l, "goal") && !strings.HasPrefix(l, "Created") {
			hint = append(hint, l)
		}
	}
	require.Len(t, hint, 1, "one line: %q", res.stdout)
	assert.Contains(t, hint[0], `#3 "Ship the goals page"`)
	assert.Contains(t, hint[0], `#5 "Cut the build time"`)
	assert.Contains(t, hint[0], "coral-board task goal 9 <goal>", "and how to link this task")

	// With --goal given there is nothing to say; with no open goal there is nothing to name; a goals read that fails says nothing and does not fail the add.
	res = goalRun(t, gs, "task", "add", "Fix it", "--goal", "3")
	assert.NotContains(t, res.stdout, "open goals")
	gs.setReply("GET /api/board/team/goals", `{"goals":[],"next_cursor":""}`)
	res = goalRun(t, gs, "task", "add", "Fix it")
	assert.Equal(t, "Created Task #9: Fix it\n", res.stdout)
	delete(gs.reply, "GET /api/board/team/goals")
	res = goalRun(t, gs, "task", "add", "Fix it")
	assert.Equal(t, 0, res.code)
}

func TestJoinListsTheOpenGoalsWithWhatMakesThemDone(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("POST /api/board/team/subscribe", `{"project":"team","subscriber_id":"Tester"}`)
	gs.setReply("GET /api/board/team/goals", twoGoals)
	res := goalRun(t, gs, "join", "team", "--as", "Developer")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "Joined 'team' as 'Developer'")
	assert.Contains(t, res.stdout, `#3 Ship the goals page`)
	assert.Contains(t, res.stdout, "done when: The page is in a release")
	assert.Contains(t, res.stdout, `#5 Cut the build time`)
	assert.Contains(t, res.stdout, "blocked", "a blocked goal says so")
	assert.Contains(t, res.stdout, "--goal <id>", "and how a task joins one")

	gs.setReply("GET /api/board/team/goals", `{"goals":[],"next_cursor":""}`)
	res = goalRun(t, gs, "join", "team", "--as", "Developer")
	assert.Equal(t, "Joined 'team' as 'Developer' (subscriber: Tester)\n", res.stdout, "a board with no goals says nothing more")
}

// #7296 round 2 (Codex Test): an agent that is already subscribed never runs join, so coral-board read tells it about the board's goals: one short block the first time it reads, and again only when the board's goals
// change (the goals list's seq moved since this agent's last read); nothing when the board has none; --json is untouched.
func TestReadPrintsTheGoalsBlockWhenTheBoardsGoalsChanged(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("GET /api/board/team/messages", `[]`)
	dir := subscribedDataDir(t, gs.URL)
	read := func(args ...string) boardRun {
		return runBoard(t, gs.URL, dir, append([]string{"read"}, args...)...)
	}

	// No goals on the board: nothing more than before.
	gs.setReply("GET /api/board/team/goals", `{"goals":[],"next_cursor":"","seq":0}`)
	res := read()
	require.Equal(t, 0, res.code, res.stderr)
	assert.Equal(t, "No new messages.\n", res.stdout)

	// A goal appears: the next read says so, with what makes it done; the read after that is quiet.
	gs.setReply("GET /api/board/team/goals", twoGoals[:len(twoGoals)-len(`,"next_cursor":""}`)]+`,"next_cursor":"","seq":4}`)
	res = read()
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "No new messages.")
	assert.Contains(t, res.stdout, `#3 Ship the goals page`)
	assert.Contains(t, res.stdout, "done when: The page is in a release")
	assert.Contains(t, res.stdout, "--goal <id>")
	res = read()
	assert.Equal(t, "No new messages.\n", res.stdout, "the same seq: said once")

	// The goals change (the seq moves): said again. --json prints no block.
	gs.setReply("GET /api/board/team/goals", twoGoals[:len(twoGoals)-len(`,"next_cursor":""}`)]+`,"next_cursor":"","seq":5}`)
	res = read("--json")
	assert.NotContains(t, res.stdout, "open goals")
	res = read()
	assert.Contains(t, res.stdout, "#5 Cut the build time")
	assert.Contains(t, res.stdout, "(blocked on the operator)")
	res = read()
	assert.Equal(t, "No new messages.\n", res.stdout)

	// A goals read that fails says nothing and does not fail the read.
	delete(gs.reply, "GET /api/board/team/goals")
	gs.setStatus(0)
	res = read()
	assert.Equal(t, 0, res.code)
}

func TestJoinSavesTheGoalsSeqSoTheFirstReadIsQuiet(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("POST /api/board/team/subscribe", `{"project":"team","subscriber_id":"Tester"}`)
	gs.setReply("GET /api/board/team/messages", `[]`)
	gs.setReply("GET /api/board/team/goals", twoGoals[:len(twoGoals)-len(`,"next_cursor":""}`)]+`,"next_cursor":"","seq":4}`)
	dir := t.TempDir()
	res := runBoard(t, gs.URL, dir, "join", "team", "--as", "Developer")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, res.stdout, "#3 Ship the goals page")
	res = runBoard(t, gs.URL, dir, "read")
	assert.Equal(t, "No new messages.\n", res.stdout, "the goals were just listed by join")
}
