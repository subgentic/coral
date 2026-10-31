package background

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// Work done off the books (#7793, goal #21 part 3): three signals in the orchestrator's check, each a switch in the team's health settings and each said once.

func (h *checkHarness) sid(n int) string { return fmt.Sprintf("%08d-0000-0000-0000-000000000000", n) }

// next lets the check interval pass and returns the check that is typed to the orchestrator.
func (h *checkHarness) next() string {
	h.t.Helper()
	h.now = h.now.Add(11 * time.Minute)
	return h.scanOut()
}

// scanOut scans the team now and returns the check typed to the orchestrator.
func (h *checkHarness) scanOut() string {
	h.t.Helper()
	h.mu.Lock()
	before := len(h.sent["Orchestrator"])
	h.mu.Unlock()
	h.m.scan(context.Background())
	h.mu.Lock()
	defer h.mu.Unlock()
	got := h.sent["Orchestrator"]
	require.Greater(h.t, len(got), before, "no check was typed to the orchestrator")
	return got[len(got)-1]
}

func (h *checkHarness) settings(mod func(*board.HealthSettings)) {
	h.t.Helper()
	hs := h.s.GetHealthSettings(context.Background(), "team")
	mod(&hs)
	require.NoError(h.t, h.s.SetHealthSettings(context.Background(), "team", hs))
}

func TestBusyWithNoTaskInProgressIsOneLineOncePerTurn(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("QA", "QA Engineer", 3, 0)
	h.member("Short", "Developer", 4, 0)
	started := map[int]time.Time{}
	turn := func(n int, ago time.Duration) {
		started[n] = h.now.Add(-ago)
		h.sig[h.sid(n)] = agentSignal{InTurn: true, Since: started[n]}
	}
	turn(1, 15*time.Minute) // the orchestrator coordinates with no task: never a line
	turn(2, 15*time.Minute)
	turn(3, 15*time.Minute)
	turn(4, 5*time.Minute) // under the 10 minutes
	work, err := h.s.CreateTask(ctx, "team", "Review", "", "medium", "Orchestrator", "QA")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "QA", work.ID)
	require.NoError(t, err)

	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, "Dev: has been working for 15 min with no task in progress")
	assert.NotContains(t, out, "QA: has been working", "a task is in progress")
	assert.NotContains(t, out, "Orchestrator: has been working")
	assert.NotContains(t, out, "Short: has been working", "not for N minutes yet")
	assert.LessOrEqual(t, len(out), teamhealth.MaxCheck)

	// the same turn, still going, is not said again (Short's has now been 16 minutes: it is said, once)
	out = h.next()
	assert.NotContains(t, out, "Dev: has been working", "once per occurrence")
	assert.Contains(t, out, "Short: has been working for 16 min with no task in progress")
	out = h.next()
	assert.NotContains(t, out, "has been working", "neither is said again")

	// a new turn is a new occurrence
	h.now = h.now.Add(11 * time.Minute)
	turn(2, 12*time.Minute)
	out = h.scanOut()
	assert.Contains(t, out, "Dev: has been working for 12 min with no task in progress")
}

func TestBusySignalFollowsItsSettings(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	turn := func(ago time.Duration) { h.sig[h.sid(2)] = agentSignal{InTurn: true, Since: h.now.Add(-ago)} }

	h.settings(func(hs *board.HealthSettings) { hs.BusyNoTask.On = false })
	turn(30 * time.Minute)
	assert.NotContains(t, h.checkTo("Orchestrator"), "has been working", "off in settings means silent")

	h.settings(func(hs *board.HealthSettings) { hs.BusyNoTask = board.HealthMentionNudge{On: true, AfterMin: 40} })
	h.now = h.now.Add(11 * time.Minute)
	turn(30 * time.Minute)
	assert.NotContains(t, h.scanOut(), "has been working", "N is a setting: 30 minutes is under 40")

	h.now = h.now.Add(11 * time.Minute)
	turn(50 * time.Minute)
	assert.Contains(t, h.scanOut(), "Dev: has been working for 50 min with no task in progress")
}

func TestACommitPostedWithNoTaskIsOneLine(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("QA", "QA Engineer", 3, 0)
	post := func(who, text string) {
		t.Helper()
		_, err := h.s.PostMessage(ctx, "team", who, text, nil)
		require.NoError(t, err)
	}
	post("Dev", "before the first scan: 5f4e3d2c") // the first scan only marks where the board is: nothing before it is judged
	h.checkTo("Orchestrator")

	// QA has a task in progress while it posts
	work, err := h.s.CreateTask(ctx, "team", "Review", "", "medium", "Orchestrator", "QA")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "QA", work.ID)
	require.NoError(t, err)
	post("QA", "fixed in a1b2c3d4 and pushed")
	post("Dev", "landed 3f2a9c1 on main")                          // fires
	post("Dev", "#7793 landed in 9d8e7f60")                        // a task number in the post
	post("Dev", "the digest (sha256 3689bac5f1d2) is in the post") // the start of an artifact digest, not a commit
	post("Dev", "1234567 and feedface are no SHAs")
	post("Dev", "a patch: coral://artifacts/"+strings.Repeat("ab", 32)) // fires, as a patch
	post("Orchestrator", "merged deadbee1")                             // the orchestrator is the one told
	post("Operator", "please check 0a1b2c3d")
	post("Ghost", "landed 0b1c2d3e") // not a member of this team
	_, err = h.s.PostSystemMessage(ctx, "team", "Coral Task Queue", "[Coral health] 4d5e6f70", nil)
	require.NoError(t, err)

	out := h.next()
	assert.Contains(t, out, "Dev: posted a commit (3f2a9c1) with no task number and no task in progress")
	assert.Contains(t, out, "Dev: posted a patch with no task number and no task in progress")
	assert.Equal(t, 2, strings.Count(out, "with no task number and no task in progress"), "only those two: "+out)
	assert.NotContains(t, out, "5f4e3d2c", "before the first scan")
	assert.NotContains(t, out, "QA: posted")

	out = h.next()
	assert.NotContains(t, out, "with no task number", "once per occurrence")

	// a post right after the task is completed still counts as made on it
	_, err = h.s.CompleteTask(ctx, "team", work.ID, "QA", nil)
	require.NoError(t, err)
	post("QA", "done, in 77aa88bb")
	assert.NotContains(t, h.next(), "QA: posted")
}

func TestThePostSignalFollowsItsSwitch(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.checkTo("Orchestrator") // the first scan
	h.settings(func(hs *board.HealthSettings) { hs.PostNoTask.On = false })
	_, err := h.s.PostMessage(ctx, "team", "Dev", "landed 3f2a9c1", nil)
	require.NoError(t, err)
	assert.NotContains(t, h.next(), "posted a commit", "off in settings means silent")
	h.settings(func(hs *board.HealthSettings) { hs.PostNoTask.On = true })
	assert.NotContains(t, h.next(), "posted a commit", "what was posted while it was off is not a backlog")
	_, err = h.s.PostMessage(ctx, "team", "Dev", "landed 4a5b6c7d", nil)
	require.NoError(t, err)
	assert.Contains(t, h.next(), "Dev: posted a commit (4a5b6c7)")
}

func TestAnUploadWithNoTaskIsOneLineAndFollowsItsSwitch(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	// the upload route notes it (routes/artifact_offbooks_test.go); the check says it
	require.NoError(t, h.s.AddOffBooks(ctx, "team", board.OffBooksUpload, "Dev", strings.Repeat("c", 64), "uploaded an artifact (cccccccc) with no task in progress", h.now))
	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, "Dev: uploaded an artifact (cccccccc) with no task in progress")
	assert.NotContains(t, h.next(), "uploaded an artifact", "once per occurrence")

	h.settings(func(hs *board.HealthSettings) { hs.UploadNoTask.On = false })
	require.NoError(t, h.s.AddOffBooks(ctx, "team", board.OffBooksUpload, "Dev", strings.Repeat("d", 64), "uploaded an artifact (dddddddd) with no task in progress", h.now))
	assert.NotContains(t, h.next(), "uploaded an artifact", "off in settings means silent")
	h.settings(func(hs *board.HealthSettings) { hs.UploadNoTask.On = true })
	assert.Contains(t, h.next(), "Dev: uploaded an artifact (dddddddd)", "what was kept while it was off is said when it is turned on")
}

func TestAnOccurrenceIsSaidAgainWhenTheCheckDidNotGoOut(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	require.NoError(t, h.s.AddOffBooks(ctx, "team", board.OffBooksUpload, "Dev", "ref1", "uploaded an artifact (ref1) with no task in progress", h.now))
	good := h.m.deliver
	h.m.deliver = func(context.Context, AgentInfo, string, string) error { return fmt.Errorf("the gate refused") }
	h.m.scan(ctx)
	h.m.deliver = good
	assert.Contains(t, h.next(), "Dev: uploaded an artifact (ref1)", "a check that failed to go out said nothing")
	assert.NotContains(t, h.next(), "uploaded an artifact (ref1)")
}

func TestAFloodOfOccurrencesIsSaidFiveAtATimeAndNeverPushesOutTheRest(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.sig[h.sid(2)] = agentSignal{Since: h.now.Add(-45 * time.Minute)} // idle: an item of the check's own
	const n = 60
	for i := 0; i < n; i++ {
		require.NoError(t, h.s.AddOffBooks(ctx, "team", board.OffBooksUpload, fmt.Sprintf("Agent%02d", i), fmt.Sprintf("r%d", i), fmt.Sprintf("uploaded an artifact (r%02d) with no task in progress", i), h.now))
	}
	seen := map[int]int{}
	for round := 0; round < n/maxOffBooksPerCheck; round++ {
		out := h.next()
		assert.LessOrEqual(t, len(out), teamhealth.MaxCheck)
		assert.Contains(t, out, "Dev: idle", "the check's own items are still there")
		said := 0
		for i := 0; i < n; i++ {
			if strings.Contains(out, fmt.Sprintf("Agent%02d: uploaded an artifact (r%02d)", i, i)) {
				seen[i]++
				said++
			}
		}
		assert.Equal(t, maxOffBooksPerCheck, said, "round %d", round)
	}
	for i := 0; i < n; i++ {
		assert.Equal(t, 1, seen[i], "Agent%02d is said exactly once", i)
	}
}

func TestCommitMentionReadsAShaOrAPatchAndNothingElse(t *testing.T) {
	art := "coral://artifacts/" + strings.Repeat("ab", 32)
	// the digest's start (sha256 3689bac5) is skipped in the fifth, the commit after it is not
	for _, c := range [][2]string{
		{"landed 3f2a9c1 on main", "a commit (3f2a9c1)"},
		{"landed 3F2A9C1E on main", "a commit (3f2a9c1)"},
		{"ad4d18ab4 + 60aeab96d", "a commit (ad4d18a)"},
		{"patch " + art, "a patch"},
		{"the Patch is here: " + art, "a patch"},
		{"deadbee1", "a commit (deadbee)"},
		{"sha256 3689bac5 then 6f52d7a3d", "a commit (6f52d7a)"},
		{"commit 0123456789abcdef0123456789abcdef01234", "a commit (0123456)"},
		{"see commit abc1234 and the commit hash 3f2a9c1", "a commit (abc1234)"},
		{"merged (3f2a9c1), then 7a1b2c3d4", "a commit (3f2a9c1)"},
		{"session 7a1b2c3d-4e5f-6789-abcd-ef0123456789 is up, landed 3f2a9c1", "a commit (3f2a9c1)"},
		{"colour #a1b2c3d4 and Task id abcdef12 and landed 5e6f7a8b", "a commit (5e6f7a8)"},
	} {
		text, want := c[0], c[1]
		got, ok := commitMention(text)
		assert.True(t, ok, text)
		assert.Equal(t, want, got, text)
	}
	for _, text := range []string{
		"", "hello", "1234567 is a number", "feedface is a word", "abcdefg is not hex", "a patch with no link", art,
		"session 7a1b2c3d-4e5f-6789-abcd-ef0123456789 is up", "uuid ef0123456789 alone", "the tail -abcd-ef0123456789 of one", "colour #a1b2c3d4", "color: a1b2c3d4", "Task id abcdef12", "ID: 7a1b2c3d",
		"ref 7a1b2c3d-4e5f-6789-abcd-ef0123456789 is up", "token=3f2a9c1e", "key \"3f2a9c1e\"", "issue #3f2a9c1", "the session (7a1b2c3d) died",
		"sha256:3689bac5f1d2 is a digest", "(sha-256 3689bac5)", "the 64 hex digest " + strings.Repeat("ab1", 21) + "a",
	} {
		_, ok := commitMention(text)
		assert.False(t, ok, text)
	}
}

func TestOnlyWhatTheDeliveredCheckSaysIsMarkedShown(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	all := map[string]bool{board.OffBooksUpload: true}
	require.NoError(t, h.s.AddOffBooks(ctx, "team", board.OffBooksUpload, "Dev", "r1", "uploaded an artifact (r1) with no task in progress", h.now))
	pending, err := h.s.PendingOffBooks(ctx, "team", h.now, all)
	require.NoError(t, err)
	require.Len(t, pending, 1)
	h.m.offShown = map[string][]offBooksShown{"team": {{id: pending[0].ID, needle: "Dev: uploaded an artifact (r1)"}}}
	h.m.markOffBooksShown(ctx, "team", "[Coral health check] a check whose line was dropped for size", h.now)
	left, _ := h.s.PendingOffBooks(ctx, "team", h.now, all)
	assert.Len(t, left, 1, "a line the check left out is said in the next one")
	h.m.offShown = map[string][]offBooksShown{"team": {{id: pending[0].ID, needle: "Dev: uploaded an artifact (r1)"}}}
	h.m.markOffBooksShown(ctx, "team", "[Coral health check] 1) Dev: uploaded an artifact (r1) with no task in progress.", h.now)
	left, _ = h.s.PendingOffBooks(ctx, "team", h.now, all)
	assert.Empty(t, left)
}

// goalTasks makes a goal of the team's board with n tasks linked to it (the board package's own helpers are not visible here).
func (h *checkHarness) goalTasks(title string, n int) int64 {
	h.t.Helper()
	ctx := context.Background()
	g, err := h.s.CreateGoal(ctx, "team", board.GoalInput{Title: title, Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(h.t, err)
	h.moreTasks(g.ID, n)
	return g.ID
}

func (h *checkHarness) moreTasks(goal int64, n int) {
	h.t.Helper()
	for i := 0; i < n; i++ {
		_, err := h.s.CreateTaskWithOpts(context.Background(), "team", "task", "", "medium", "Operator", &board.CreateTaskOpts{GoalID: &goal})
		require.NoError(h.t, err)
	}
}

func TestAGoalWithTooManyTasksIsOneLineOncePerCrossing(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	g := h.goalTasks("Secret goal title", 15)
	line := func(id int64, n, limit int) string {
		return fmt.Sprintf("Board: Goal #%d has %d tasks (limit %d): consider splitting it or closing what is done", id, n, limit)
	}
	out := h.checkTo("Orchestrator")
	assert.NotContains(t, out, "has 15 tasks", "15 is the limit, not past it")

	h.moreTasks(g, 1)
	out = h.next()
	assert.Contains(t, out, line(g, 16, 15))
	assert.NotContains(t, outsideGoals(out), "Secret goal title", "the off-books line is numbers only: never the goal's title (the GOALS segment names goals, #11412)")
	assert.NotContains(t, h.next(), "has 16 tasks", "once per crossing")

	h.moreTasks(g, 13)
	assert.NotContains(t, h.next(), "Goal #", "29 tasks is not another step")
	h.moreTasks(g, 1)
	assert.Contains(t, h.next(), line(g, 30, 15), "30 is the next step")
	assert.NotContains(t, h.next(), "Goal #")
}

func TestTheGoalSizeSignalFollowsItsSettings(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	g := h.goalTasks("g", 12)
	h.settings(func(hs *board.HealthSettings) { hs.GoalSize.On = false })
	assert.NotContains(t, h.checkTo("Orchestrator"), "Goal #", "12 is under the limit anyway")
	h.moreTasks(g, 10) // 22 tasks
	assert.NotContains(t, h.next(), "Goal #", "off in settings means silent")

	h.settings(func(hs *board.HealthSettings) { hs.GoalSize = board.HealthGoalSize{On: true, Limit: 30} })
	assert.NotContains(t, h.next(), "Goal #", "the limit is a setting: 22 is under 30")
	h.settings(func(hs *board.HealthSettings) { hs.GoalSize.Limit = 20 })
	assert.Contains(t, h.next(), fmt.Sprintf("Board: Goal #%d has 22 tasks (limit 20)", g), "turned on or lowered: a goal over the limit is said once")
	assert.NotContains(t, h.next(), "Goal #")
}

func TestAClosedGoalIsNotCounted(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	done := h.goalTasks("done", 20)
	dropped := h.goalTasks("dropped", 20)
	open := h.goalTasks("open", 20)
	_, _, err := h.s.CloseGoal(ctx, "team", done, "its done-when is met", board.GoalDone)
	require.NoError(t, err)
	_, _, err = h.s.CloseGoal(ctx, "team", dropped, "not wanted", board.GoalDropped)
	require.NoError(t, err)
	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, fmt.Sprintf("Goal #%d has 20 tasks", open))
	assert.NotContains(t, out, fmt.Sprintf("Goal #%d ", done), "done: its done-when is met")
	assert.NotContains(t, out, fmt.Sprintf("Goal #%d ", dropped))
	assert.Equal(t, 1, strings.Count(out, "consider splitting it"), out)
}

func TestAGoalThatShrinksAndGrowsBackIsSaidAgain(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	g := h.goalTasks("g", 16)
	assert.Contains(t, h.checkTo("Orchestrator"), fmt.Sprintf("Goal #%d has 16 tasks", g))
	tasks, err := h.s.ListOpenTasks(ctx, "team")
	require.NoError(t, err)
	for _, tk := range tasks[:8] { // eight tasks move to no goal: 8 left
		require.NoError(t, h.s.SetTaskGoal(ctx, "team", tk.ID, nil))
	}
	assert.NotContains(t, h.next(), "Goal #", "below the limit: nothing to say")
	h.moreTasks(g, 9) // 17 again
	assert.Contains(t, h.next(), fmt.Sprintf("Goal #%d has 17 tasks", g), "a new crossing is a new line")
}

func TestAGoalLineKeptWhileTheSwitchWasOffIsNotSaid(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	require.NoError(t, h.s.AddOffBooks(ctx, "team", board.OffBooksGoalSize, "Board", "7|1|1", "Goal #7 has 16 tasks (limit 15): consider splitting it or closing what is done", h.now))
	h.settings(func(hs *board.HealthSettings) { hs.GoalSize.On = false })
	assert.NotContains(t, h.checkTo("Orchestrator"), "Goal #7", "off in settings means silent, a line already kept included")
	h.settings(func(hs *board.HealthSettings) { hs.GoalSize.On = true })
	assert.Contains(t, h.next(), "Board: Goal #7 has 16 tasks (limit 15)", "and said once when it is turned on")
}
