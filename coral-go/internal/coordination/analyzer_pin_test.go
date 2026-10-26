package coordination

// Pinning tests for the analyzer (#8279, from the #8180 split proposal): what Analyze reports today, finding by finding, over small seeded boards, so a later split of
// analyzer.go (or a rewrite of one detector) is proved by tests and not by reading. Each table row is one rule or one threshold, with the value on both sides of it. A rule
// that used to depend on map order (subscriber loads outside the status, churn incidents, the agents of a handoff loop, the shared words of a duplicate pair) is sorted now (#8292) and
// asked many times in TestPinMapOrderedOutputsAreSorted; the quirks the code has are pinned under a name that says so. They are named TestPin... so `go test -run TestPin` runs just these.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var pinT0 = time.Date(2026, 9, 29, 6, 0, 0, 0, time.UTC)

// pinAt is the RFC 3339 text of the instant `sec` seconds after pinT0.
func pinAt(sec int) string { return pinT0.Add(time.Duration(sec) * time.Second).Format(time.RFC3339) }

// pinTime is the instant `sec` seconds after pinT0.
func pinTime(sec int) time.Time { return pinT0.Add(time.Duration(sec) * time.Second) }

func pinTask(id int64, status string, createdSec int) Task {
	return Task{ID: id, Title: fmt.Sprintf("Task %d", id), Status: status, CreatedAt: pinAt(createdSec)}
}

func pinMsg(id int64, who, content string, sec int) Message {
	return Message{ID: id, SubscriberID: who, Content: content, CreatedAt: pinAt(sec)}
}

func sorted(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func TestPinEmptyBoard(t *testing.T) {
	r := Analyze(nil, nil, nil, ReportFilter{Board: "empty"}, pinT0)
	assert.Equal(t, "empty", r.Metadata.Board)
	assert.True(t, r.Metadata.GeneratedAt.Equal(pinT0))
	assert.Zero(t, r.Metadata.TotalTasksInWindow)
	assert.Zero(t, r.Metadata.TotalMessagesInWindow)
	assert.Zero(t, r.Metadata.SubscribersTracked)
	assert.Equal(t, TaskCounts{}, r.ObservableFacts.TaskCounts)
	assert.Equal(t, TimingMetrics{}, r.ObservableFacts.Durations)
	assert.Equal(t, ActiveLoadMetrics{}, r.ObservableFacts.ActiveVsPlannedLoad)
	assert.Empty(t, r.ObservableFacts.DependencyGraph.BlockedTasks)
	assert.Empty(t, r.ObservableFacts.ReviewHeldSlots)
	assert.Equal(t, HeuristicSignals{}, r.HeuristicSignals)
	assert.Len(t, r.UnavailableMetrics, 5)
	assert.Equal(t, []string{"Total tasks in window: 0 (Completed: 0, In Progress: 0, Pending: 0, Blocked: 0, Cancelled: 0)"}, r.KeyFindings)
	assert.Equal(t, []string{"Queue coordination is operating smoothly with balanced slot utilization and low notification churn."}, r.Recommendations)
	s := r.CoordinationScore
	assert.True(t, s.ScoreSuppressed)
	assert.Zero(t, s.TotalScore)
	assert.Zero(t, s.ObservedPoints)
	assert.Zero(t, s.AvailablePoints)
	assert.Zero(t, s.CoverageRatio)
	assert.Equal(t, "Suppressed / Insufficient evidence", s.ValidationStatus)
	assert.Zero(t, s.ClaimPromptnessScore+s.SlotFluidityScore+s.DependencyClarityScore+s.NotificationCleanScore+s.RecoveryEconomyScore)

	// no clock given: the report is stamped with the current time
	assert.False(t, Analyze(nil, nil, nil, ReportFilter{}, time.Time{}).Metadata.GeneratedAt.IsZero())
}

func TestPinWindowFilter(t *testing.T) {
	since, until := pinTime(0), pinTime(100)
	tasks := []Task{
		pinTask(1, "pending", -1),                           // before the window
		pinTask(2, "pending", 0),                            // the first instant is in
		pinTask(3, "pending", 100),                          // the last instant is in
		pinTask(4, "pending", 101),                          // after
		{ID: 5, Status: "pending", CreatedAt: "not a time"}, // unreadable: kept, never filtered out
		{ID: 6, Status: "pending", CreatedAt: ""},           // empty: kept too
	}
	msgs := []Message{
		pinMsg(1, "a", "x", -1), pinMsg(2, "a", "x", 0), pinMsg(3, "a", "x", 100), pinMsg(4, "a", "x", 101),
		{ID: 5, SubscriberID: "a", Content: "x", CreatedAt: "garbage"},
	}
	for _, c := range []struct {
		name         string
		since, until *time.Time
		tasks, msgs  int
	}{
		{"no window", nil, nil, 6, 5},
		{"since only", &since, nil, 5, 4},
		{"until only", nil, &until, 5, 4},
		{"both ends", &since, &until, 4, 3},
	} {
		r := Analyze(tasks, msgs, nil, ReportFilter{Since: c.since, Until: c.until}, pinTime(200))
		assert.Equal(t, c.tasks, r.Metadata.TotalTasksInWindow, c.name)
		assert.Equal(t, c.msgs, r.Metadata.TotalMessagesInWindow, c.name)
		assert.Equal(t, c.since, r.Metadata.WindowStart, c.name)
		assert.Equal(t, c.until, r.Metadata.WindowEnd, c.name)
	}
}

func TestPinTaskCounts(t *testing.T) {
	var tasks []Task
	for i, s := range []string{"completed", "completed", "in_progress", "pending", "pending", "pending", "blocked", "cancelled", "skipped", "skipped", "review_pending", ""} {
		tasks = append(tasks, pinTask(int64(i+1), s, 0))
	}
	// a status the counts do not know is in the total and in no bucket
	assert.Equal(t, TaskCounts{TotalCreated: 12, Completed: 2, InProgress: 1, Pending: 3, Blocked: 1, Cancelled: 1, Skipped: 2}, countTasks(tasks))
	assert.Equal(t, TaskCounts{}, countTasks(nil))
}

func TestPinDurations(t *testing.T) {
	claim := func(id int64, created, claimed int, deps ...int64) Task {
		tk := pinTask(id, "in_progress", created)
		tk.ClaimedAt = strPtr(pinAt(claimed))
		for _, d := range deps {
			tk.BlockedBy = append(tk.BlockedBy, TaskDep{TaskID: d})
		}
		return tk
	}
	done := func(id int64, completed int) Task {
		tk := pinTask(id, "completed", -1000)
		tk.CompletedAt = strPtr(pinAt(completed))
		return tk
	}
	one := func(v float64) DurationStats {
		return DurationStats{Count: 1, MinSec: v, MaxSec: v, MeanSec: v, MedSec: v, P90Sec: v}
	}

	for _, c := range []struct {
		name        string
		cohort, all []Task
		ready, wait DurationStats
	}{
		{"no prerequisite: ready is creation", []Task{claim(1, 0, 30)}, nil, one(30), one(30)},
		{"a finished prerequisite: ready is its completion", []Task{claim(1, 0, 130, 2)}, []Task{done(2, 100)}, one(30), one(130)},
		{"two prerequisites: the latest completion", []Task{claim(1, 0, 230, 2, 3)}, []Task{done(2, 100), done(3, 200)}, one(30), one(230)},
		{"a prerequisite unknown to the board: ready is creation", []Task{claim(1, 0, 130, 2)}, nil, one(130), one(130)},
		{"one prerequisite known, one not: ready is creation", []Task{claim(1, 0, 130, 2, 3)}, []Task{done(2, 100)}, one(130), one(130)},
		{"claimed before the prerequisite finished: never negative", []Task{claim(1, 0, 50, 2)}, []Task{done(2, 100)}, one(0), one(50)},
	} {
		m := computeDurations(c.cohort, append(append([]Task(nil), c.cohort...), c.all...))
		assert.Equal(t, c.ready, m.ReadyToClaimLatency, c.name)
		assert.Equal(t, c.wait, m.TotalPreClaimWait, c.name)
	}

	// the timestamps a task lacks: counted, not measured
	bad := func(mut func(*Task)) Task { tk := pinTask(9, "completed", 0); mut(&tk); return tk }
	for _, c := range []struct {
		name    string
		task    Task
		missing int
	}{
		{"completed with no claim", bad(func(tk *Task) { tk.CompletedAt = strPtr(pinAt(10)) }), 1},
		{"in progress with no claim", func() Task { tk := pinTask(9, "in_progress", 0); return tk }(), 1},
		{"pending with no claim is fine", func() Task { tk := pinTask(9, "pending", 0); return tk }(), 0},
		{"completed with no completion time", bad(func(tk *Task) { tk.ClaimedAt = strPtr(pinAt(5)) }), 1},
		{"unreadable claim", bad(func(tk *Task) { tk.ClaimedAt = strPtr("soon"); tk.CompletedAt = strPtr(pinAt(10)) }), 1},
		{"unreadable completion", bad(func(tk *Task) { tk.ClaimedAt = strPtr(pinAt(5)); tk.CompletedAt = strPtr("later") }), 1},
		{"unreadable creation: the task is skipped whole", bad(func(tk *Task) { tk.CreatedAt = "never"; tk.ClaimedAt = strPtr(pinAt(5)) }), 1},
		{"all three present", bad(func(tk *Task) { tk.ClaimedAt = strPtr(pinAt(5)); tk.CompletedAt = strPtr(pinAt(25)) }), 0},
	} {
		m := computeDurations([]Task{c.task}, []Task{c.task})
		assert.Equal(t, c.missing, m.MissingTimestamps, c.name)
	}

	// lead time and execution time
	full := bad(func(tk *Task) { tk.ClaimedAt = strPtr(pinAt(5)); tk.CompletedAt = strPtr(pinAt(25)) })
	m := computeDurations([]Task{full}, []Task{full})
	assert.Equal(t, one(25), m.TotalLeadTime)
	assert.Equal(t, one(20), m.ExecutionDuration)
	// completed without a claim: a lead time, no execution time
	noClaim := bad(func(tk *Task) { tk.CompletedAt = strPtr(pinAt(25)) })
	m = computeDurations([]Task{noClaim}, []Task{noClaim})
	assert.Equal(t, one(25), m.TotalLeadTime)
	assert.Equal(t, DurationStats{}, m.ExecutionDuration)
}

func TestPinCalcStats(t *testing.T) {
	seq := func(n int) []float64 {
		v := make([]float64, n)
		for i := range v {
			v[i] = float64(n - i) // descending: the function sorts
		}
		return v
	}
	assert.Equal(t, DurationStats{}, calcStats(nil))
	for _, c := range []struct {
		n                        int
		min, max, mean, med, p90 float64
	}{
		{1, 1, 1, 1, 1, 1},
		{2, 1, 2, 1.5, 1.5, 2},
		{3, 1, 3, 2, 2, 3},
		{5, 1, 5, 3, 3, 5},
		{10, 1, 10, 5.5, 5.5, 9},
		{11, 1, 11, 6, 6, 10},
		{20, 1, 20, 10.5, 10.5, 18},
	} {
		got := calcStats(seq(c.n))
		assert.Equal(t, DurationStats{Count: c.n, MinSec: c.min, MaxSec: c.max, MeanSec: c.mean, MedSec: c.med, P90Sec: c.p90}, got, "n=%d", c.n)
	}
	// the input is not reordered
	in := []float64{3, 1, 2}
	calcStats(in)
	assert.Equal(t, []float64{3, 1, 2}, in)
}

func TestPinActiveLoad(t *testing.T) {
	since := pinTime(0)
	assigned := func(tk Task, who string) Task { tk.AssignedTo = strPtr(who); return tk }
	tasks := []Task{
		assigned(pinTask(1, "in_progress", -500), "X"), // created before the window and still open: carryover
		assigned(pinTask(2, "pending", 10), "X"),
		pinTask(3, "blocked", 20),
		assigned(pinTask(4, "completed", 30), "X"),
		assigned(pinTask(5, "in_progress", 40), "Z"), // active, and not in the status
		assigned(pinTask(6, "blocked", 50), "X"),
		pinTask(7, "pending", 60),
	}
	status := &BoardStatus{Agents: []SubscriberStatus{
		{SubscriberID: "X", Role: "Builder", Availability: "busy"},
		{SubscriberID: "Y", Role: "Reviewer", Availability: "available", Tasks: []TaskRef{{ID: 5, Status: "blocked"}, {ID: 77, Status: "in_progress"}}},
	}}
	r := Analyze(tasks, nil, status, ReportFilter{Since: &since}, pinTime(1000))
	l := r.ObservableFacts.ActiveVsPlannedLoad

	// the window's own cohort: task 1 is out of it
	assert.Equal(t, 1, l.ActiveInProgressTasks, "only task 5 is in progress inside the window")
	assert.Equal(t, 1, l.PlannedAssignedTasks, "task 2: pending and assigned")
	assert.Equal(t, 1, l.UnassignedPendingTasks, "task 7: pending, nobody; the blocked task 3 is not pending")
	// the board as a whole
	assert.Equal(t, 2, l.BoardWideActiveTasks)
	assert.Equal(t, 4, l.BoardWidePendingTasks, "pending and blocked: 2, 3, 6, 7")
	require.Len(t, l.CarryoverOlderTasks, 1)
	assert.Equal(t, CarryoverTask{ID: 1, Title: "Task 1", Status: "in_progress", Assignee: "X", CreatedAt: pinAt(-500)}, l.CarryoverOlderTasks[0])

	require.Len(t, l.SubscriberLoad, 3)
	assert.Equal(t, SubscriberLoad{SubscriberID: "X", Role: "Builder", Availability: "busy", ActiveTaskID: 1, QueuedCount: 2}, l.SubscriberLoad[0], "X: active 1, queued 2 (pending 2 and blocked 6)")
	assert.Equal(t, SubscriberLoad{SubscriberID: "Y", Role: "Reviewer", Availability: "available", ActiveTaskID: 77}, l.SubscriberLoad[1], "Y has no task of its own: the status's in_progress task stands in")
	assert.Equal(t, SubscriberLoad{SubscriberID: "Z", Role: "Z", Availability: "busy", ActiveTaskID: 5}, l.SubscriberLoad[2], "Z is not in the status: listed after it, role and availability made up")

	// without a window start there is no carryover, whatever is open
	r = Analyze(tasks, nil, status, ReportFilter{}, pinTime(1000))
	assert.Empty(t, r.ObservableFacts.ActiveVsPlannedLoad.CarryoverOlderTasks)
	assert.Equal(t, 2, r.ObservableFacts.ActiveVsPlannedLoad.ActiveInProgressTasks, "no window: the cohort is the board")
	assert.Equal(t, 2, r.Metadata.SubscribersTracked-0, "SubscribersTracked counts the status's agents")
}

func TestPinDependencies(t *testing.T) {
	blocked := pinTask(10, "blocked", 0)
	blocked.AssignedTo = strPtr("Dev")
	blocked.BlockedBy = []TaskDep{{TaskID: 11}, {TaskID: 12, Condition: "failure"}, {TaskID: 13, Condition: "success"}, {TaskID: 99}}
	notBlocked := pinTask(14, "pending", 0)
	notBlocked.BlockedBy = []TaskDep{{TaskID: 11}} // a dependency on a task that is not blocked is not listed
	tasks := []Task{blocked, pinTask(11, "completed", 0), pinTask(12, "in_progress", 0), pinTask(13, "cancelled", 0), notBlocked}
	d := computeDependencies(tasks)
	assert.Equal(t, 1, d.TotalBlockedTasks)
	require.Len(t, d.BlockedTasks, 1)
	b := d.BlockedTasks[0]
	assert.Equal(t, int64(10), b.TaskID)
	assert.Equal(t, "Dev", b.Assignee)
	assert.Equal(t, []DependencyStatus{
		{PrerequisiteID: 11, CurrentStatus: "completed", Condition: "success", Satisfied: true},
		{PrerequisiteID: 12, CurrentStatus: "in_progress", Condition: "failure", Satisfied: false},
		{PrerequisiteID: 13, CurrentStatus: "cancelled", Condition: "success", Satisfied: false},
		{PrerequisiteID: 99, CurrentStatus: "unknown/external", Condition: "success", Satisfied: false},
	}, b.Dependencies)
	assert.Equal(t, DependencyMetrics{}, computeDependencies(nil))

	// a prerequisite outside the window is unknown to the dependency graph (it is built from the window's tasks)
	since := pinTime(0)
	old := pinTask(20, "completed", -100)
	waits := pinTask(21, "blocked", 5)
	waits.BlockedBy = []TaskDep{{TaskID: 20}}
	r := Analyze([]Task{old, waits}, nil, nil, ReportFilter{Since: &since}, pinTime(10))
	require.Len(t, r.ObservableFacts.DependencyGraph.BlockedTasks, 1)
	assert.Equal(t, "unknown/external", r.ObservableFacts.DependencyGraph.BlockedTasks[0].Dependencies[0].CurrentStatus)
}

func TestPinReviewHeldSlots(t *testing.T) {
	review := func(id int64, claimed *string, role string) Task {
		tk := pinTask(id, "in_progress", 0)
		tk.ClaimedAt = claimed
		tk.AssignedTo = strPtr("Author")
		tk.Workflow = &TaskWorkflow{CompletionReview: &CompletionReview{ReviewerRole: role, Status: "pending"}}
		return tk
	}
	plainWorkflow := pinTask(5, "in_progress", 0)
	plainWorkflow.Workflow = &TaskWorkflow{Outcome: "x"}
	tasks := []Task{
		review(1, strPtr(pinAt(100)), "QA"),
		review(2, nil, "Security"),
		review(3, strPtr("not a time"), "UI"),
		pinTask(4, "in_progress", 0),
		plainWorkflow,
	}
	got := computeReviewHeldSlots(tasks, pinTime(220))
	assert.Equal(t, []ReviewHeldTask{
		{TaskID: 1, Title: "Task 1", Assignee: "Author", ReviewerRole: "QA", DurationSec: 120},
		{TaskID: 2, Title: "Task 2", Assignee: "Author", ReviewerRole: "Security", DurationSec: 0},
		{TaskID: 3, Title: "Task 3", Assignee: "Author", ReviewerRole: "UI", DurationSec: 0},
	}, got, "a task is held when a completion review is set on it; the time held runs from its claim")
	assert.Empty(t, computeReviewHeldSlots(nil, pinTime(1)))
}

func TestPinReadyUnclaimed(t *testing.T) {
	pending := func(id int64, who, prio string, created int) Task {
		tk := pinTask(id, "pending", created)
		tk.Priority = prio
		if who != "" {
			tk.AssignedTo = strPtr(who)
		}
		return tk
	}
	active := pinTask(50, "in_progress", 0)
	active.AssignedTo = strPtr("Busy")
	unreadable := pending(6, "Idle", "low", 0)
	unreadable.CreatedAt = "unreadable"
	tasks := []Task{
		active,
		pending(1, "", "high", 100),         // nobody
		pending(2, "Busy", "medium", 200),   // its owner has an active task
		pending(3, "Idle", "low", 300),      // its owner is free
		pending(4, "Waiting", "low", 400),   // its owner is busy by the status's word, with no active task of its own
		pending(5, "Stranger", "high", 500), // not in the status at all: idle
		unreadable,
		pinTask(7, "blocked", 0), // only pending tasks count
		pinTask(8, "completed", 0),
	}
	status := &BoardStatus{Agents: []SubscriberStatus{
		{SubscriberID: "Busy", Role: "B", Availability: "busy"},
		{SubscriberID: "Idle", Role: "I", Availability: "available"},
		{SubscriberID: "Waiting", Role: "W", Availability: "busy"},
	}}
	r := Analyze(tasks, nil, status, ReportFilter{}, pinTime(1000)).HeuristicSignals.ReadyUnclaimed

	assert.Equal(t, 1, r.UnassignedCount)
	assert.Equal(t, []ReadyTaskDetail{{TaskID: 1, Title: "Task 1", Priority: "high", Assignee: "—", AgeSeconds: 900, OwnerStatus: "unassigned"}}, r.UnassignedTasks)

	assert.Equal(t, 2, r.OwnerBusyCount)
	assert.Equal(t, []ReadyTaskDetail{
		{TaskID: 2, Title: "Task 2", Priority: "medium", Assignee: "Busy", AgeSeconds: 800, OwnerStatus: "busy_with_active_task", OwnerActiveID: 50},
		{TaskID: 4, Title: "Task 4", Priority: "low", Assignee: "Waiting", AgeSeconds: 600, OwnerStatus: "busy_with_active_task"},
	}, r.OwnerBusyTasks)

	assert.Equal(t, 3, r.OwnerIdleCount)
	assert.Equal(t, []ReadyTaskDetail{
		{TaskID: 3, Title: "Task 3", Priority: "low", Assignee: "Idle", AgeSeconds: 700, OwnerStatus: "idle_available"},
		{TaskID: 5, Title: "Task 5", Priority: "high", Assignee: "Stranger", AgeSeconds: 500, OwnerStatus: "idle_available"},
		{TaskID: 6, Title: "Task 6", Priority: "low", Assignee: "Idle", AgeSeconds: 0, OwnerStatus: "idle_available"},
	}, r.OwnerIdleTasks, "an unreadable creation time is an age of 0")
}

func TestPinReadyUnclaimedBusyByActiveTaskAlone(t *testing.T) {
	// an owner whose status says "available" but who holds an active task is busy; an owner whose status says "busy" with no active task is busy too (the other half is in TestPinReadyUnclaimed)
	active := pinTask(50, "in_progress", 0)
	active.AssignedTo = strPtr("Holder")
	queued := pinTask(51, "pending", 0)
	queued.AssignedTo = strPtr("Holder")
	status := &BoardStatus{Agents: []SubscriberStatus{{SubscriberID: "Holder", Role: "H", Availability: "available"}}}
	r := Analyze([]Task{active, queued}, nil, status, ReportFilter{}, pinTime(10)).HeuristicSignals.ReadyUnclaimed
	assert.Equal(t, 1, r.OwnerBusyCount)
	assert.Equal(t, 0, r.OwnerIdleCount)
	assert.Equal(t, int64(50), r.OwnerBusyTasks[0].OwnerActiveID)
}

func TestPinActiveWithoutProgress(t *testing.T) {
	now := pinTime(10_000)
	run := func(claimedAgo int, who string) Task {
		tk := pinTask(1, "in_progress", 0)
		tk.AssignedTo = strPtr(who)
		tk.ClaimedAt = strPtr(pinAt(10_000 - claimedAgo))
		return tk
	}
	limit := 15 * 60
	for _, c := range []struct {
		name   string
		filter time.Duration
		ago    int
		want   bool
	}{
		{"default limit: one second short", 0, limit - 1, false},
		{"default limit: exactly at it", 0, limit, true},
		{"negative limit means the default", -time.Second, limit, true},
		{"negative limit, short of the default", -time.Second, limit - 1, false},
		{"custom limit: short", 60 * time.Second, 59, false},
		{"custom limit: at it", 60 * time.Second, 60, true},
	} {
		got := Analyze([]Task{run(c.ago, "Dev")}, nil, nil, ReportFilter{InactivityLimit: c.filter}, now).HeuristicSignals.ActiveWithoutProgress
		assert.Equal(t, c.want, len(got) == 1, c.name)
	}

	// what is reported
	msgs := []Message{
		pinMsg(1, "Dev", "early", 9_000), pinMsg(2, "Dev", "late", 9_500), pinMsg(3, "Dev", "earlier again", 9_200),
		pinMsg(4, "Other", "later but not Dev", 9_900), {ID: 5, SubscriberID: "Dev", Content: "unreadable", CreatedAt: "never"},
	}
	got := Analyze([]Task{run(2000, "Dev")}, msgs, nil, ReportFilter{}, now).HeuristicSignals.ActiveWithoutProgress
	require.Len(t, got, 1)
	assert.Equal(t, int64(1), got[0].TaskID)
	assert.Equal(t, "Dev", got[0].Assignee)
	assert.Equal(t, 2000.0, got[0].DurationSeconds)
	assert.True(t, got[0].ClaimedAt.Equal(pinTime(8_000)))
	require.NotNil(t, got[0].LastMessageAt)
	assert.True(t, got[0].LastMessageAt.Equal(pinTime(9_500)), "the assignee's latest readable message")
	assert.True(t, strings.HasPrefix(got[0].ConfidenceNote, "Candidate indicator only."))
	// an assignee who never posted has no last message
	got = Analyze([]Task{run(2000, "Quiet")}, msgs, nil, ReportFilter{}, now).HeuristicSignals.ActiveWithoutProgress
	require.Len(t, got, 1)
	assert.Nil(t, got[0].LastMessageAt)

	// which tasks count at all
	skip := func(mut func(*Task)) []ActiveWithoutProgress {
		tk := run(5000, "Dev")
		mut(&tk)
		return Analyze([]Task{tk}, nil, nil, ReportFilter{}, now).HeuristicSignals.ActiveWithoutProgress
	}
	assert.Empty(t, skip(func(tk *Task) { tk.Status = "pending" }), "only in progress")
	assert.Empty(t, skip(func(tk *Task) { tk.ClaimedAt = nil }), "no claim time")
	assert.Empty(t, skip(func(tk *Task) { tk.ClaimedAt = strPtr("") }), "empty claim time")
	assert.Empty(t, skip(func(tk *Task) { tk.ClaimedAt = strPtr("sometime") }), "unreadable claim time")
	assert.Len(t, skip(func(tk *Task) {}), 1)
}

func TestPinNotificationChurn(t *testing.T) {
	claimed := func(id int64, claimedSec int, who string) Task {
		tk := pinTask(id, "in_progress", 0)
		tk.ClaimedAt = strPtr(pinAt(claimedSec))
		if who != "" {
			tk.AssignedTo = strPtr(who)
		}
		return tk
	}
	types := func(in []NotificationChurnIncident) []string {
		var out []string
		for _, i := range in {
			out = append(out, fmt.Sprintf("%d:%s:%d", i.TaskID, i.ChurnType, i.NoticeCount))
		}
		sort.Strings(out)
		return out
	}

	t.Run("stale unclaimed reminder: the three phrases and the two second grace", func(t *testing.T) {
		for _, phrase := range []string{"#7 is still unclaimed", "#7 is unclaimed", "#7 unclaimed and blocks the release", "#7 IS STILL UNCLAIMED"} {
			got := detectNotificationChurn([]Message{pinMsg(1, "Lead", phrase, 103)}, []Task{claimed(7, 100, "Dev")})
			require.Len(t, got, 1, phrase)
			assert.Equal(t, "stale_unclaimed_reminder", got[0].ChurnType, phrase)
			assert.Equal(t, 3.0, got[0].StaleInformationAgeSec, phrase)
		}
		// at the claim, one second after, and exactly the grace: not stale
		for _, after := range []int{0, 1, 2} {
			got := detectNotificationChurn([]Message{pinMsg(1, "Lead", "#7 is unclaimed", 100+after)}, []Task{claimed(7, 100, "Dev")})
			assert.Empty(t, got, "%d s after the claim is within the grace", after)
		}
		// before the claim the reminder was right
		assert.Empty(t, detectNotificationChurn([]Message{pinMsg(1, "Lead", "#7 is unclaimed", 50)}, []Task{claimed(7, 100, "Dev")}))
		// a task that was never claimed: the reminder is right
		assert.Empty(t, detectNotificationChurn([]Message{pinMsg(1, "Lead", "#7 is unclaimed", 500)}, []Task{pinTask(7, "pending", 0)}))
		// an unreadable message time is skipped
		assert.Empty(t, detectNotificationChurn([]Message{{ID: 1, SubscriberID: "Lead", Content: "#7 is unclaimed", CreatedAt: "x"}}, []Task{claimed(7, 100, "Dev")}))
	})

	t.Run("stale reminder: who is blamed and what is kept", func(t *testing.T) {
		got := detectNotificationChurn([]Message{pinMsg(1, "Lead", "Task #7 is unclaimed", 160)}, []Task{claimed(7, 100, "")})
		require.Len(t, got, 1)
		assert.Equal(t, "Lead", got[0].Assignee, "a task with no assignee: the sender stands in")
		assert.Equal(t, "Lead", got[0].Sender)
		assert.Equal(t, 1, got[0].NoticeCount)
		assert.Equal(t, 60.0, got[0].TimeSpanSec)
		assert.True(t, got[0].FirstNoticeAt.Equal(pinTime(100)), "first notice is the claim")
		assert.True(t, got[0].LastNoticeAt.Equal(pinTime(160)))
		require.NotNil(t, got[0].ClaimedAt)
		assert.Equal(t, "Task #7 is unclaimed", got[0].SampleMessage)
		assert.True(t, strings.HasPrefix(got[0].Confidence, "High (message at "))
	})

	t.Run("a stale reminder keeps the task out of the nudging count", func(t *testing.T) {
		msgs := []Message{pinMsg(1, "L", "#7 is unclaimed", 110), pinMsg(2, "L", "please #7", 111), pinMsg(3, "L", "please #7", 112), pinMsg(4, "L", "please #7", 113)}
		got := detectNotificationChurn(msgs, []Task{claimed(7, 100, "Dev")})
		assert.Equal(t, []string{"7:stale_unclaimed_reminder:1"}, types(got))
	})

	t.Run("nudging: count and span thresholds", func(t *testing.T) {
		nudges := func(secs ...int) []Message {
			var out []Message
			for i, s := range secs {
				out = append(out, pinMsg(int64(i+1), "Lead", "please look at #8", s))
			}
			return out
		}
		for _, c := range []struct {
			name string
			secs []int
			want string
		}{
			{"three within 179 s", []int{0, 90, 179}, "8:rapid_nudging:3"},
			{"three over exactly 180 s", []int{0, 90, 180}, ""},
			{"three within 80 s are rapid, not repeated", []int{0, 40, 80}, "8:rapid_nudging:3"},
			{"two within 89 s", []int{0, 89}, "8:repeated_notices:2"},
			{"two over exactly 90 s", []int{0, 90}, ""},
			{"two far apart", []int{0, 600}, ""},
			{"one alone", []int{0}, ""},
			{"four within 179 s", []int{0, 50, 100, 179}, "8:rapid_nudging:4"},
		} {
			got := detectNotificationChurn(nudges(c.secs...), []Task{pinTask(8, "pending", 0)})
			if c.want == "" {
				assert.Empty(t, got, c.name)
			} else {
				assert.Equal(t, []string{c.want}, types(got), c.name)
			}
		}
	})

	t.Run("nudging: what is kept", func(t *testing.T) {
		msgs := []Message{pinMsg(1, "A", "nudge #8", 0), pinMsg(2, "B", "still waiting on #8", 30), pinMsg(3, "C", "final reminder #8", 60)}
		tk := claimed(8, -10, "Dev")
		got := detectNotificationChurn(msgs, []Task{tk})
		require.Len(t, got, 1)
		assert.Equal(t, int64(8), got[0].TaskID)
		assert.Equal(t, "Dev", got[0].Assignee)
		assert.Equal(t, 3, got[0].NoticeCount)
		assert.Equal(t, 60.0, got[0].TimeSpanSec)
		assert.Equal(t, "final reminder #8", got[0].SampleMessage, "the last message")
		assert.Equal(t, "C", got[0].Sender)
		assert.True(t, got[0].FirstNoticeAt.Equal(pinTime(0)))
		assert.True(t, got[0].LastNoticeAt.Equal(pinTime(60)))
		require.NotNil(t, got[0].ClaimedAt)
		assert.Equal(t, "Medium (based on frequency and timespan heuristic)", got[0].Confidence)
		assert.Equal(t, "3 messages referenced Task #8 within 60s.", got[0].AnalysisNote)
		// no claim on the task: no claim time; an unknown task: no assignee
		got = detectNotificationChurn(msgs, nil)
		require.Len(t, got, 1)
		assert.Nil(t, got[0].ClaimedAt)
		assert.Equal(t, "", got[0].Assignee)
	})

	t.Run("which words make a message a nudge, and which end it", func(t *testing.T) {
		for _, w := range []string{"nudge", "reminder", "please", "still", "waiting", "blocking", "PLEASE"} {
			got := detectNotificationChurn([]Message{pinMsg(1, "L", w+" #9", 0), pinMsg(2, "L", w+" #9", 10)}, nil)
			assert.Len(t, got, 1, "trigger %q", w)
		}
		for _, w := range []string{"hello", "fyi", "done"} {
			assert.Empty(t, detectNotificationChurn([]Message{pinMsg(1, "L", w+" #9", 0), pinMsg(2, "L", w+" #9", 10)}, nil), "no trigger %q", w)
		}
		for _, w := range []string{"completed", "complete.", "outcome:", "unblocked", "claimed by", "landed", "COMPLETED"} {
			got := detectNotificationChurn([]Message{pinMsg(1, "L", "please "+w+" #9", 0), pinMsg(2, "L", "please "+w+" #9", 10)}, nil)
			assert.Empty(t, got, "lifecycle word %q ends it", w)
		}
		// no task number, no incident
		assert.Empty(t, detectNotificationChurn([]Message{pinMsg(1, "L", "please", 0), pinMsg(2, "L", "please", 10)}, nil))
		// an unreadable time on an end of the run drops the incident
		bad := []Message{pinMsg(1, "L", "please #9", 0), {ID: 2, SubscriberID: "L", Content: "please #9", CreatedAt: "?"}}
		assert.Empty(t, detectNotificationChurn(bad, nil))
	})

	t.Run("several tasks: one incident each (compared as a set: the order is the map's)", func(t *testing.T) {
		msgs := []Message{
			pinMsg(1, "L", "please #1", 0), pinMsg(2, "L", "please #1", 10),
			pinMsg(3, "L", "please #2", 0), pinMsg(4, "L", "please #2", 10), pinMsg(5, "L", "please #2", 20),
		}
		got := detectNotificationChurn(msgs, nil)
		assert.Equal(t, []string{"1:repeated_notices:2", "2:rapid_nudging:3"}, types(got))
	})
}

func TestPinManualRecovery(t *testing.T) {
	cancelled := pinTask(1, "cancelled", 10)
	cancelled.CompletedBy = strPtr("Orchestrator")
	cancelled.CompletionMessage = strPtr("superseded")
	retry := pinTask(2, "pending", 20)
	retry.CreatedBy = "Lead"
	retry.Workflow = &TaskWorkflow{RetryOf: 1}
	both := pinTask(3, "cancelled", 30)
	both.CreatedBy = "Lead"
	both.Workflow = &TaskWorkflow{RetryOf: 2}
	notRetry := pinTask(4, "pending", 40)
	notRetry.Workflow = &TaskWorkflow{RetryOf: 0}
	msgs := []Message{
		pinMsg(1, "Orchestrator", "Task 5 reassigned to Dev B", 50),
		pinMsg(2, "Orchestrator", "Reassigned to Dev C", 60), // capital R: not matched, the test is case-sensitive
		pinMsg(3, "Dev", "all good", 70),
	}
	got := detectManualRecovery([]Task{cancelled, retry, both, notRetry}, msgs)
	assert.Equal(t, []ManualRecoveryEvent{
		{TaskID: 1, Title: "Task 1", EventType: "cancellation", Actor: "Orchestrator", Timestamp: pinTime(10), Reason: "superseded"},
		{TaskID: 2, Title: "Task 2", EventType: "retry", Actor: "Lead", Timestamp: pinTime(20), Predecessor: 1, Reason: "Retry of predecessor task"},
		{TaskID: 3, Title: "Task 3", EventType: "cancellation", Actor: "", Timestamp: pinTime(30)},
		{TaskID: 3, Title: "Task 3", EventType: "retry", Actor: "Lead", Timestamp: pinTime(30), Predecessor: 2, Reason: "Retry of predecessor task"},
		{Title: "Task 5 reassigned to Dev B", EventType: "reassignment", Actor: "Orchestrator", Timestamp: pinTime(50), Reason: "Task 5 reassigned to Dev B"},
	}, got, "tasks in order (a cancelled retry is both), then reassignment messages")
	assert.Empty(t, detectManualRecovery(nil, nil))
}

func TestPinDuplicateScope(t *testing.T) {
	titled := func(id int64, title string, createdSec int) Task {
		tk := pinTask(id, "pending", createdSec)
		tk.Title = title
		return tk
	}
	pair := func(a, b string, gapSec int) []DuplicateScopeCandidate {
		return detectDuplicateScopeCandidates([]Task{titled(1, a, 0), titled(2, b, gapSec)})
	}
	hour := 3600
	for _, c := range []struct {
		name       string
		a, b       string
		gap        int
		want       bool
		similarity float64
		shared     []string
	}{
		{"identical titles", "Fix login redirect", "Fix login redirect", 0, true, 1, []string{"fix", "login", "redirect"}},
		{"jaccard exactly one half (2 shared of 4): reported is the larger of jaccard and overlap, 2/3, to two places", "alpha beta gamma", "alpha beta delta", 0, true, 0.67, []string{"alpha", "beta"}},
		{"jaccard just under a half", "alpha beta gamma delta", "alpha beta epsilon zeta", 0, false, 0, nil},
		{"overlap of 3 words in a longer title", "alpha beta gamma", "alpha beta gamma delta epsilon zeta eta theta", 0, true, 1, []string{"alpha", "beta", "gamma"}},
		{"overlap 1.0 but only 2 shared words and jaccard low", "alpha beta", "alpha beta gamma delta epsilon zeta eta theta", 0, false, 0, nil},
		{"jaccard 0.4 (2 of 5), overlap 2/3: below both rules", "alpha beta gamma", "alpha beta delta epsilon", 0, false, 0, nil},
		{"overlap 0.6 (3 of 5) with 3 shared: below the 0.7 rule", "alpha beta gamma delta epsilon", "alpha beta gamma zeta eta theta iota kappa lambda omega", 0, false, 0, nil},
		{"overlap exactly 0.7 (7 of 10) with 7 shared, jaccard under a half: reported", "alpha beta gamma delta epsilon zeta eta theta iota kappa", "alpha beta gamma delta epsilon zeta eta lambda omega sigma phi tau", 0, true, 0.7, []string{"alpha", "beta", "delta", "epsilon", "eta", "gamma", "zeta"}},
		{"a title inside a longer one: overlap 1.0 beats jaccard 0.75", "alpha beta gamma", "alpha beta gamma delta", 0, true, 1, []string{"alpha", "beta", "gamma"}},
		{"six hours apart exactly: still close", "alpha beta gamma", "alpha beta gamma", 6 * hour, true, 1, []string{"alpha", "beta", "gamma"}},
		{"one second past six hours: not close", "alpha beta gamma", "alpha beta gamma", 6*hour + 1, false, 0, nil},
		{"stop words and short words do not count", "the fix of a UI to bug", "fix bug on the in", 0, true, 1, []string{"bug", "fix"}},
		{"only stop words: no tokens, no pair", "the and for", "the and for", 0, false, 0, nil},
		{"digits split words and are dropped: step1 and step2 are the same word", "step1 alpha beta", "step2 alpha beta", 0, true, 1, []string{"alpha", "beta", "step"}},
	} {
		got := pair(c.a, c.b, c.gap)
		if !c.want {
			assert.Empty(t, got, c.name)
			continue
		}
		require.Len(t, got, 1, c.name)
		assert.Equal(t, c.similarity, got[0].Similarity, c.name)
		assert.Equal(t, c.shared, sorted(got[0].SharedWords), c.name)
		assert.Equal(t, int64(1), got[0].TaskID1, c.name)
		assert.Equal(t, int64(2), got[0].TaskID2, c.name)
		assert.Equal(t, c.a, got[0].Title1, c.name)
		assert.Equal(t, c.b, got[0].Title2, c.name)
	}

	// an unreadable creation time on either side skips the six-hour test
	far := titled(2, "alpha beta gamma", 0)
	far.CreatedAt = "unreadable"
	got := detectDuplicateScopeCandidates([]Task{titled(1, "alpha beta gamma", 0), far})
	assert.Len(t, got, 1)
	// pairs run in task order: (1,2), (1,3), (2,3)
	three := []Task{titled(1, "alpha beta gamma", 0), titled(2, "alpha beta gamma", 10), titled(3, "alpha beta gamma", 20)}
	var ids []string
	for _, d := range detectDuplicateScopeCandidates(three) {
		ids = append(ids, fmt.Sprintf("%d-%d", d.TaskID1, d.TaskID2))
	}
	assert.Equal(t, []string{"1-2", "1-3", "2-3"}, ids)
}

func TestPinRepetitiveHandoffs(t *testing.T) {
	pingPong := func(n, stepSec int) []Message {
		var out []Message
		for i := 0; i < n; i++ {
			who := "A"
			if i%2 == 1 {
				who = "B"
			}
			out = append(out, pinMsg(int64(i+1), who, "ping", i*stepSec))
		}
		return out
	}
	assert.Empty(t, detectRepetitiveHandoffs(nil))
	assert.Empty(t, detectRepetitiveHandoffs(pingPong(3, 1)), "fewer than 4 messages")
	assert.Empty(t, detectRepetitiveHandoffs(pingPong(5, 1)), "fewer than a window of 6")

	got := detectRepetitiveHandoffs(pingPong(6, 20)) // 6 messages over 100 s
	require.Len(t, got, 1)
	assert.Equal(t, []string{"A", "B"}, sorted(got[0].Agents))
	assert.Equal(t, 6, got[0].MessageCount)
	assert.Equal(t, 100.0, got[0].TimeSpanSec)
	assert.True(t, got[0].FirstTime.Equal(pinTime(0)))
	assert.True(t, got[0].LastTime.Equal(pinTime(100)))
	assert.Contains(t, got[0].Summary, "Rapid 6-message back-and-forth between ")
	assert.Contains(t, got[0].Summary, "within 100s")
	assert.Contains(t, got[0].Summary, "A")
	assert.Contains(t, got[0].Summary, "B")

	assert.Len(t, detectRepetitiveHandoffs(pingPong(6, 23)), 1, "119 s is under the limit")
	assert.Empty(t, detectRepetitiveHandoffs(pingPong(6, 24)), "exactly 120 s is not")

	// a window is skipped past once it is reported
	assert.Len(t, detectRepetitiveHandoffs(pingPong(11, 1)), 1)
	assert.Len(t, detectRepetitiveHandoffs(pingPong(12, 1)), 2)
	assert.Len(t, detectRepetitiveHandoffs(pingPong(18, 1)), 3)

	// three voices in the window: not a ping-pong; one voice: not either
	three := pingPong(6, 1)
	three[2].SubscriberID = "C"
	assert.Empty(t, detectRepetitiveHandoffs(three))
	one := pingPong(6, 1)
	for i := range one {
		one[i].SubscriberID = "A"
	}
	assert.Empty(t, detectRepetitiveHandoffs(one))
}

// The quirks of the handoff detector today, pinned so a rewrite changes them on purpose: a window whose times cannot be read has a span of 0 and is reported with zero times.
func TestPinRepetitiveHandoffsQuirkUnreadableTimes(t *testing.T) {
	var msgs []Message
	for i := 0; i < 6; i++ {
		who := []string{"A", "B"}[i%2]
		msgs = append(msgs, Message{ID: int64(i + 1), SubscriberID: who, Content: "x", CreatedAt: "unreadable"})
	}
	got := detectRepetitiveHandoffs(msgs)
	require.Len(t, got, 1)
	assert.Equal(t, 0.0, got[0].TimeSpanSec)
	assert.True(t, got[0].FirstTime.IsZero())
}

func TestPinScorecard(t *testing.T) {
	h := func(idle, stalled, churn, recovery int) HeuristicSignals {
		var s HeuristicSignals
		s.ReadyUnclaimed.OwnerIdleCount = idle
		s.ActiveWithoutProgress = make([]ActiveWithoutProgress, stalled)
		s.NotificationChurn = make([]NotificationChurnIncident, churn)
		s.ManualRecoveryEvents = make([]ManualRecoveryEvent, recovery)
		return s
	}
	score := func(counts TaskCounts, heur HeuristicSignals, blocked, messages int) CoordinationScorecard {
		return computeScorecard(counts, TimingMetrics{}, heur, DependencyMetrics{TotalBlockedTasks: blocked}, messages)
	}
	tasks4 := TaskCounts{TotalCreated: 4}

	clean := score(tasks4, h(0, 0, 0, 0), 0, 5)
	assert.Equal(t, 100.0, clean.TotalScore)
	assert.Equal(t, 100.0, clean.AvailablePoints)
	assert.Equal(t, 1.0, clean.CoverageRatio)
	assert.False(t, clean.ScoreSuppressed)
	assert.Equal(t, "Provisional / Pending Audit", clean.ValidationStatus)
	assert.Empty(t, clean.SuppressionRationale)

	// each deduction, with its cap
	for _, c := range []struct {
		name  string
		got   float64
		field string
		want  float64
	}{
		{"idle 1", score(tasks4, h(1, 0, 0, 0), 0, 5).ClaimPromptnessScore, "promptness", 21},
		{"idle 5 hits the cap", score(tasks4, h(5, 0, 0, 0), 0, 5).ClaimPromptnessScore, "promptness", 5},
		{"idle 6 stays at the cap", score(tasks4, h(6, 0, 0, 0), 0, 5).ClaimPromptnessScore, "promptness", 5},
		{"idle 100 stays at the cap", score(tasks4, h(100, 0, 0, 0), 0, 5).ClaimPromptnessScore, "promptness", 5},
		{"stalled 1", score(tasks4, h(0, 1, 0, 0), 0, 5).SlotFluidityScore, "fluidity", 20},
		{"stalled 4 hits the cap", score(tasks4, h(0, 4, 0, 0), 0, 5).SlotFluidityScore, "fluidity", 5},
		{"stalled 9 stays at the cap", score(tasks4, h(0, 9, 0, 0), 0, 5).SlotFluidityScore, "fluidity", 5},
		{"churn 1", score(tasks4, h(0, 0, 1, 0), 0, 5).NotificationCleanScore, "notification", 12},
		{"churn 4 hits the cap", score(tasks4, h(0, 0, 4, 0), 0, 5).NotificationCleanScore, "notification", 3},
		{"churn 5 stays at the cap", score(tasks4, h(0, 0, 5, 0), 0, 5).NotificationCleanScore, "notification", 3},
		{"recovery 1", score(tasks4, h(0, 0, 0, 1), 0, 5).RecoveryEconomyScore, "recovery", 12.5},
		{"recovery 3", score(tasks4, h(0, 0, 0, 3), 0, 5).RecoveryEconomyScore, "recovery", 7.5},
		{"recovery 4 hits the cap", score(tasks4, h(0, 0, 0, 4), 0, 5).RecoveryEconomyScore, "recovery", 5},
		{"recovery 5 stays at the cap", score(tasks4, h(0, 0, 0, 5), 0, 5).RecoveryEconomyScore, "recovery", 5},
		// dependency clarity: strictly more than a quarter costs 5, strictly more than a half costs 10
		{"blocked 0 of 4", score(tasks4, h(0, 0, 0, 0), 0, 5).DependencyClarityScore, "dependency", 20},
		{"blocked 1 of 4 is exactly a quarter", score(tasks4, h(0, 0, 0, 0), 1, 5).DependencyClarityScore, "dependency", 20},
		{"blocked 2 of 4 is exactly a half", score(tasks4, h(0, 0, 0, 0), 2, 5).DependencyClarityScore, "dependency", 15},
		{"blocked 3 of 4", score(tasks4, h(0, 0, 0, 0), 3, 5).DependencyClarityScore, "dependency", 10},
		{"blocked 4 of 4", score(tasks4, h(0, 0, 0, 0), 4, 5).DependencyClarityScore, "dependency", 10},
		{"blocked 1 of 3 is a third", score(TaskCounts{TotalCreated: 3}, h(0, 0, 0, 0), 1, 5).DependencyClarityScore, "dependency", 15},
	} {
		assert.Equal(t, c.want, c.got, c.name)
	}

	// the total is the sum when every dimension has evidence, rounded to a tenth
	busy := score(tasks4, h(1, 1, 1, 1), 2, 5)
	assert.Equal(t, 21.0+20+15+12+12.5, busy.TotalScore)
	assert.Equal(t, busy.TotalScore, busy.ObservedPoints)

	// coverage: tasks only, messages only, neither
	tasksOnly := score(tasks4, h(0, 0, 1, 0), 0, 0)
	assert.True(t, tasksOnly.ScoreSuppressed)
	assert.Equal(t, 85.0, tasksOnly.AvailablePoints)
	assert.Equal(t, 0.85, tasksOnly.CoverageRatio)
	assert.Equal(t, 85.0, tasksOnly.ObservedPoints)
	assert.Zero(t, tasksOnly.TotalScore, "a suppressed score is 0, the points stay in ObservedPoints")
	assert.Zero(t, tasksOnly.NotificationCleanScore, "no messages: no notification credit")
	assert.Equal(t, "Suppressed / Incomplete evidence", tasksOnly.ValidationStatus)
	assert.Contains(t, tasksOnly.SuppressionRationale, "board message stream")
	assert.NotContains(t, tasksOnly.SuppressionRationale, "task lifecycle")

	messagesOnly := score(TaskCounts{}, h(0, 0, 2, 0), 0, 7)
	assert.True(t, messagesOnly.ScoreSuppressed)
	assert.Equal(t, 15.0, messagesOnly.AvailablePoints)
	assert.Equal(t, 0.15, messagesOnly.CoverageRatio)
	assert.Equal(t, 9.0, messagesOnly.ObservedPoints)
	assert.Equal(t, 9.0, messagesOnly.NotificationCleanScore)
	assert.Zero(t, messagesOnly.ClaimPromptnessScore+messagesOnly.SlotFluidityScore+messagesOnly.DependencyClarityScore+messagesOnly.RecoveryEconomyScore, "no tasks: the task dimensions are 0, not full credit")
	assert.Equal(t, "Suppressed / Incomplete evidence", messagesOnly.ValidationStatus)
	assert.Contains(t, messagesOnly.SuppressionRationale, "task lifecycle events")
	assert.NotContains(t, messagesOnly.SuppressionRationale, "message stream")

	neither := score(TaskCounts{}, h(0, 0, 0, 0), 0, 0)
	assert.Equal(t, 0.0, neither.AvailablePoints)
	assert.Equal(t, "Suppressed / Insufficient evidence", neither.ValidationStatus)
	assert.Contains(t, neither.SuppressionRationale, "task lifecycle events")
	assert.Contains(t, neither.SuppressionRationale, "board message stream")
}

func TestPinKeyFindingsAndRecommendations(t *testing.T) {
	var f ObservableFacts
	var h HeuristicSignals
	f.TaskCounts = TaskCounts{TotalCreated: 9, Completed: 4, InProgress: 2, Pending: 1, Blocked: 1, Cancelled: 1}
	base := generateKeyFindings(f, h)
	assert.Equal(t, []string{"Total tasks in window: 9 (Completed: 4, In Progress: 2, Pending: 1, Blocked: 1, Cancelled: 1)"}, base)

	f.Durations.ReadyToClaimLatency = DurationStats{Count: 3, MedSec: 12.34, P90Sec: 56.78, MeanSec: 20}
	f.Durations.ExecutionDuration = DurationStats{Count: 2, MedSec: 100, P90Sec: 200}
	h.ReadyUnclaimed.OwnerBusyCount = 2
	h.ReadyUnclaimed.OwnerIdleCount = 3
	h.NotificationChurn = make([]NotificationChurnIncident, 4)
	h.ActiveWithoutProgress = make([]ActiveWithoutProgress, 5)
	h.DuplicateScopeCandidates = make([]DuplicateScopeCandidate, 6)
	f.ReviewHeldSlots = []ReviewHeldTask{{TaskID: 11, Title: "A", ReviewerRole: "QA", DurationSec: 120}, {TaskID: 12, Title: "B", ReviewerRole: "Security", DurationSec: 900}}
	h.RepetitiveHandoffLoops = []RepetitiveHandoffLoop{{Agents: []string{"Amy", "Zed"}, MessageCount: 6, TimeSpanSec: 100, Summary: "Rapid 6-message back-and-forth between Amy & Zed within 100s"}, {Agents: []string{"A", "B"}}}
	got := generateKeyFindings(f, h)
	require.Len(t, got, 10)
	assert.Equal(t, base[0], got[0])
	assert.Equal(t, "Median claim latency: 12.3s (P90: 56.8s, Mean: 20.0s across 3 claims)", got[1])
	assert.Equal(t, "Median execution duration: 100.0s (P90: 200.0s across 2 completed tasks)", got[2])
	assert.True(t, strings.HasPrefix(got[3], "Observable planned serialization: 2 ready task(s) are queued behind"), got[3])
	assert.Equal(t, "Coordination lag candidate: 3 ready task(s) assigned to currently idle subscribers remain unclaimed.", got[4])
	assert.Equal(t, "Notification churn observed in 4 incident(s): reminders dispatched for tasks already claimed or in rapid (<2m) succession.", got[5])
	assert.Equal(t, "Active duration observation: 5 task(s) in progress exceed threshold (candidate status, not proof of inactivity).", got[6])
	// the wording states the detector's own rule (#8292): a half the words in common (jaccard), or 70% of the shorter title with 3 shared words, within 6 hours
	assert.Equal(t, "Duplicate scope candidates: 6 pair(s) of tasks created within 6 hours of each other have overlapping titles (at least half their words in common, or 70% of the shorter title's words with 3 or more shared).", got[7])
	assert.Equal(t, "Review-held slots: 2 task(s) hold a slot while a completion review is pending (longest: task #12, 900s, reviewer Security).", got[8])
	assert.Equal(t, "Repetitive handoff loops: 2 rapid back-and-forth exchange(s) between the same two agents; the first: Rapid 6-message back-and-forth between Amy & Zed within 100s.", got[9])

	// each finding appears on its own condition
	for _, c := range []struct {
		name string
		mut  func(*ObservableFacts, *HeuristicSignals)
		want string
	}{
		{"claim latency needs a claim", func(f *ObservableFacts, h *HeuristicSignals) { f.Durations.ReadyToClaimLatency.Count = 1 }, "Median claim latency"},
		{"execution needs a completed task", func(f *ObservableFacts, h *HeuristicSignals) { f.Durations.ExecutionDuration.Count = 1 }, "Median execution duration"},
		{"busy backlog", func(f *ObservableFacts, h *HeuristicSignals) { h.ReadyUnclaimed.OwnerBusyCount = 1 }, "Observable planned serialization"},
		{"idle lag", func(f *ObservableFacts, h *HeuristicSignals) { h.ReadyUnclaimed.OwnerIdleCount = 1 }, "Coordination lag candidate"},
		{"churn", func(f *ObservableFacts, h *HeuristicSignals) {
			h.NotificationChurn = make([]NotificationChurnIncident, 1)
		}, "Notification churn"},
		{"stalled", func(f *ObservableFacts, h *HeuristicSignals) {
			h.ActiveWithoutProgress = make([]ActiveWithoutProgress, 1)
		}, "Active duration observation"},
		{"duplicates", func(f *ObservableFacts, h *HeuristicSignals) {
			h.DuplicateScopeCandidates = make([]DuplicateScopeCandidate, 1)
		}, "Duplicate scope candidates"},
		{"review-held slot", func(f *ObservableFacts, h *HeuristicSignals) {
			f.ReviewHeldSlots = []ReviewHeldTask{{TaskID: 3, ReviewerRole: "QA"}}
		}, "Review-held slots: 1 task(s)"},
		{"handoff loop", func(f *ObservableFacts, h *HeuristicSignals) {
			h.RepetitiveHandoffLoops = []RepetitiveHandoffLoop{{Summary: "S"}}
		}, "Repetitive handoff loops: 1 rapid"},
	} {
		var ff ObservableFacts
		var hh HeuristicSignals
		c.mut(&ff, &hh)
		lines := generateKeyFindings(ff, hh)
		require.Len(t, lines, 2, c.name)
		assert.Contains(t, lines[1], c.want, c.name)
	}

	// recommendations
	assert.Equal(t, []string{"Queue coordination is operating smoothly with balanced slot utilization and low notification churn."}, generateRecommendations(ObservableFacts{}, HeuristicSignals{}, CoordinationScorecard{}))
	var rf ObservableFacts
	var rh HeuristicSignals
	rf.TaskCounts.Blocked = 1
	rh.ReadyUnclaimed.OwnerIdleCount = 2
	rh.NotificationChurn = make([]NotificationChurnIncident, 1)
	rh.DuplicateScopeCandidates = make([]DuplicateScopeCandidate, 1)
	recs := generateRecommendations(rf, rh, CoordinationScorecard{})
	require.Len(t, recs, 4)
	assert.Equal(t, "Dispatch targeted nudges with explicit claim IDs (coral-board task claim <ID>) for the 2 unclaimed task(s) assigned to idle subscribers.", recs[0])
	assert.Equal(t, "Debounce orchestrator reminders against actual task claim state to avoid alerting on already-claimed tasks.", recs[1])
	assert.Equal(t, "Monitor upstream prerequisites for blocked tasks to ensure prompt unblocking upon prerequisite completion.", recs[2])
	assert.Equal(t, "Review overlapping task titles before launch to clarify task boundaries and prevent duplicated agent work.", recs[3])
	// the "smoothly" line is only for a board with nothing to say; a stalled task alone says nothing, so it is "smoothly" too (quirk: no recommendation for it)
	var stalled HeuristicSignals
	stalled.ActiveWithoutProgress = make([]ActiveWithoutProgress, 3)
	assert.Equal(t, []string{"Queue coordination is operating smoothly with balanced slot utilization and low notification churn."}, generateRecommendations(ObservableFacts{}, stalled, CoordinationScorecard{}))
}

func TestPinParseTime(t *testing.T) {
	want := time.Date(2026, 9, 29, 6, 11, 59, 0, time.UTC)
	for _, s := range []string{"2026-09-29T06:11:59Z", "2026-09-29T06:11:59.000000000Z", "2026-09-29 06:11:59", "2026-09-29T06:11:59+00:00"} {
		got, err := parseTime(s)
		require.NoError(t, err, s)
		assert.True(t, got.Equal(want), s)
	}
	got, err := parseTime("2026-09-29T08:11:59+02:00")
	require.NoError(t, err)
	assert.True(t, got.Equal(want), "an offset is honored")
	got, err = parseTime("2026-09-29T06:11:59.5Z")
	require.NoError(t, err)
	assert.Equal(t, 500_000_000, got.Nanosecond())
	for _, s := range []string{"", "yesterday", "2026-09-29", "29/09/2026 06:11"} {
		_, err := parseTime(s)
		assert.Error(t, err, "%q", s)
	}
}

func TestPinExtractTaskIDs(t *testing.T) {
	for _, c := range []struct {
		in   string
		want []int64
	}{
		{"", nil},
		{"no ids here", nil},
		{"#12", []int64{12}},
		{"#12 and #7", []int64{12, 7}},
		{"#12 again #12", []int64{12}},
		{"#0 is not a task", nil},
		{"#12abc", []int64{12}},
		{"# 12", nil},
		{"task 5 is late", []int64{5}},
		{"Task 5 is late", []int64{5}},
		{"task claim 9 now", []int64{9}},
		{"Task #3 and task 4", []int64{3, 4}},
		{"#3 then task 3", []int64{3}},
		{"tasks 5 and 6", nil},
		{"task 0", nil},
		{"see #1, #2, #3", []int64{1, 2, 3}},
	} {
		assert.Equal(t, c.want, extractTaskIDs(c.in), "%q", c.in)
	}
}

func TestPinTokenizeAndJaccard(t *testing.T) {
	stop := map[string]bool{"the": true, "and": true}
	assert.Equal(t, []string{"fix", "login", "redirect"}, tokenize("Fix the login-redirect", stop))
	assert.Equal(t, []string{"abc"}, tokenize("ab abc AB", stop), "two letters and fewer are dropped")
	assert.Equal(t, []string{"step", "alpha"}, tokenize("step1 alpha2", stop), "a digit splits a word and is dropped")
	assert.Nil(t, tokenize("", stop))

	s, shared := jaccardSimilarity(nil, nil)
	assert.Zero(t, s)
	assert.Nil(t, shared)
	s, shared = jaccardSimilarity([]string{"a", "b"}, []string{"c"})
	assert.Zero(t, s)
	assert.Empty(t, shared)
	s, shared = jaccardSimilarity([]string{"a", "b", "b"}, []string{"b", "c", "b"})
	assert.InDelta(t, 1.0/3, s, 1e-9, "repeats count once")
	assert.Equal(t, []string{"b"}, shared)
}

// seededBoard is one board with something to report in every part of the report whose output does not depend on map order (no duplicate pair, no handoff loop, one churn incident).
func seededBoard() ([]Task, []Message, *BoardStatus, ReportFilter) {
	since, until := pinTime(-3600), pinTime(7200)
	mk := func(id int64, status string, who string, created int) Task {
		tk := pinTask(id, status, created)
		tk.Title = []string{"", "Build the importer", "Review the importer", "Write release notes", "Migrate settings storage", "Fix the cache key", "Rerun the nightly index"}[id]
		tk.Priority = []string{"", "high", "medium", "low", "high", "medium", "high"}[id]
		tk.CreatedBy = "Orchestrator"
		if who != "" {
			tk.AssignedTo = strPtr(who)
		}
		return tk
	}
	t1 := mk(1, "completed", "Dev", 0)
	t1.ClaimedAt, t1.CompletedAt = strPtr(pinAt(60)), strPtr(pinAt(900))
	t1.CompletedBy = strPtr("Dev")
	t2 := mk(2, "in_progress", "Reviewer", 100)
	t2.ClaimedAt = strPtr(pinAt(1000))
	t2.Workflow = &TaskWorkflow{CompletionReview: &CompletionReview{ReviewerRole: "QA", Status: "pending"}}
	t3 := mk(3, "blocked", "Writer", 200)
	t3.BlockedBy = []TaskDep{{TaskID: 2}, {TaskID: 4, Condition: "failure"}}
	t4 := mk(4, "pending", "Dev", 300)
	t5 := mk(5, "cancelled", "", 400)
	t5.CompletedBy, t5.CompletionMessage = strPtr("Orchestrator"), strPtr("superseded by #6")
	t6 := mk(6, "in_progress", "Dev2", 500)
	t6.ClaimedAt = strPtr(pinAt(1200))
	t6.Workflow = &TaskWorkflow{RetryOf: 5}
	msgs := []Message{
		pinMsg(1, "Orchestrator", "Task #6 is still unclaimed, please pick it up", 1500),
		pinMsg(2, "Dev2", "working on it", 1600),
		pinMsg(3, "Orchestrator", "Task 4 reassigned to Dev", 1700),
	}
	status := &BoardStatus{Board: "seeded", Agents: []SubscriberStatus{
		{SubscriberID: "Dev", Role: "Backend", Availability: "available"},
		{SubscriberID: "Reviewer", Role: "QA", Availability: "busy"},
		{SubscriberID: "Writer", Role: "Docs", Availability: "available"},
	}}
	return []Task{t1, t2, t3, t4, t5, t6}, msgs, status, ReportFilter{Board: "seeded", Since: &since, Until: &until, InactivityLimit: 30 * time.Minute}
}

func TestPinSeededReportFactsAndSignals(t *testing.T) {
	tasks, msgs, status, filter := seededBoard()
	r := Analyze(tasks, msgs, status, filter, pinTime(3600))

	assert.Equal(t, TaskCounts{TotalCreated: 6, Completed: 1, InProgress: 2, Pending: 1, Blocked: 1, Cancelled: 1}, r.ObservableFacts.TaskCounts)
	assert.Equal(t, 3, r.Metadata.SubscribersTracked)
	assert.Equal(t, 6, r.Metadata.TotalTasksInWindow)
	assert.Equal(t, 3, r.Metadata.TotalMessagesInWindow)

	// timing: task 1 waited 60 s, ran 840 s, took 900 s; the claimed tasks 2 and 6 waited 900 s and 700 s
	assert.Equal(t, 3, r.ObservableFacts.Durations.TotalPreClaimWait.Count)
	assert.Equal(t, 60.0, r.ObservableFacts.Durations.TotalPreClaimWait.MinSec)
	assert.Equal(t, 900.0, r.ObservableFacts.Durations.TotalPreClaimWait.MaxSec)
	assert.Equal(t, 700.0, r.ObservableFacts.Durations.TotalPreClaimWait.MedSec)
	assert.Equal(t, DurationStats{Count: 1, MinSec: 840, MaxSec: 840, MeanSec: 840, MedSec: 840, P90Sec: 840}, r.ObservableFacts.Durations.ExecutionDuration)
	assert.Equal(t, DurationStats{Count: 1, MinSec: 900, MaxSec: 900, MeanSec: 900, MedSec: 900, P90Sec: 900}, r.ObservableFacts.Durations.TotalLeadTime)

	// review held: task 2 since its claim at 1000, now 3600
	assert.Equal(t, []ReviewHeldTask{{TaskID: 2, Title: "Review the importer", Assignee: "Reviewer", ReviewerRole: "QA", DurationSec: 2600}}, r.ObservableFacts.ReviewHeldSlots)

	// blocked: task 3 waits on 2 (in progress) and 4 (pending, a failure condition)
	require.Len(t, r.ObservableFacts.DependencyGraph.BlockedTasks, 1)
	assert.Equal(t, []DependencyStatus{
		{PrerequisiteID: 2, CurrentStatus: "in_progress", Condition: "success"},
		{PrerequisiteID: 4, CurrentStatus: "pending", Condition: "failure"},
	}, r.ObservableFacts.DependencyGraph.BlockedTasks[0].Dependencies)

	// ready and unclaimed: task 4 is Dev's and Dev is free
	assert.Equal(t, 1, r.HeuristicSignals.ReadyUnclaimed.OwnerIdleCount)
	// active without progress: with a 30 minute limit task 2 (claimed 2600 s ago) is in, task 6 (2400 s) is in too
	var stalled []int64
	for _, c := range r.HeuristicSignals.ActiveWithoutProgress {
		stalled = append(stalled, c.TaskID)
	}
	assert.Equal(t, []int64{2, 6}, stalled)
	// churn: the stale reminder for task 6, claimed at 1200 and reminded at 1500
	require.Len(t, r.HeuristicSignals.NotificationChurn, 1)
	assert.Equal(t, "stale_unclaimed_reminder", r.HeuristicSignals.NotificationChurn[0].ChurnType)
	assert.Equal(t, 300.0, r.HeuristicSignals.NotificationChurn[0].StaleInformationAgeSec)
	// recovery: the cancelled task, the retry, the reassignment message
	var kinds []string
	for _, e := range r.HeuristicSignals.ManualRecoveryEvents {
		kinds = append(kinds, e.EventType)
	}
	assert.Equal(t, []string{"cancellation", "retry", "reassignment"}, kinds)
	assert.Empty(t, r.HeuristicSignals.DuplicateScopeCandidates)
	assert.Empty(t, r.HeuristicSignals.RepetitiveHandoffLoops)

	// the scorecard: 1 idle task, 2 stalled, 1 of 6 blocked, 1 churn, 3 recovery events
	s := r.CoordinationScore
	assert.False(t, s.ScoreSuppressed)
	assert.Equal(t, 21.0, s.ClaimPromptnessScore)
	assert.Equal(t, 15.0, s.SlotFluidityScore)
	assert.Equal(t, 20.0, s.DependencyClarityScore)
	assert.Equal(t, 12.0, s.NotificationCleanScore)
	assert.Equal(t, 7.5, s.RecoveryEconomyScore)
	assert.Equal(t, 75.5, s.TotalScore)
}

// The whole Markdown report of the seeded board is the golden below: the section order, the words, the tables. CORAL_UPDATE_GOLDEN=1 rewrites it (and the diff is read before it is committed).
func TestPinSeededReportMarkdownGolden(t *testing.T) {
	tasks, msgs, status, filter := seededBoard()
	got := FormatMarkdown(Analyze(tasks, msgs, status, filter, pinTime(3600)))
	assertGolden(t, "testdata/pin_report.md", got)
}

func TestPinSeededReportJSONGolden(t *testing.T) {
	tasks, msgs, status, filter := seededBoard()
	got, err := FormatJSON(Analyze(tasks, msgs, status, filter, pinTime(3600)))
	require.NoError(t, err)
	assertGolden(t, "testdata/pin_report.json", got+"\n")
}

func assertGolden(t *testing.T, path, got string) {
	t.Helper()
	if os.Getenv("CORAL_UPDATE_GOLDEN") != "" {
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(t, os.WriteFile(path, []byte(got), 0o644))
		return
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, strings.ReplaceAll(string(want), "\r\n", "\n"), got)
}

// The four outputs that used to depend on map order (#8292, from #8279's pinning) are now in a fixed order: a report of the same board is the same every time. Each is asked 60 times
// (a map's order differs from call to call), with enough entries that an unsorted result could not be the same 60 times by chance.
func TestPinMapOrderedOutputsAreSorted(t *testing.T) {
	const runs = 60

	t.Run("subscribers outside the status are listed by id", func(t *testing.T) {
		var tasks []Task
		for i, who := range []string{"Echo", "Alpha", "Delta", "Bravo", "Charlie"} {
			tk := pinTask(int64(i+1), "in_progress", 0)
			tk.AssignedTo = strPtr(who)
			tasks = append(tasks, tk)
		}
		for i := 0; i < runs; i++ {
			load := Analyze(tasks, nil, nil, ReportFilter{}, pinTime(10)).ObservableFacts.ActiveVsPlannedLoad.SubscriberLoad
			var ids []string
			for _, l := range load {
				ids = append(ids, l.SubscriberID)
			}
			require.Equal(t, []string{"Alpha", "Bravo", "Charlie", "Delta", "Echo"}, ids, "run %d", i)
		}
	})

	t.Run("churn incidents are listed by task id", func(t *testing.T) {
		var msgs []Message
		for _, id := range []int{5, 3, 9, 1, 7, 2} {
			msgs = append(msgs, pinMsg(int64(id*10), "L", fmt.Sprintf("please #%d", id), 0), pinMsg(int64(id*10+1), "L", fmt.Sprintf("please #%d", id), 10))
		}
		for i := 0; i < runs; i++ {
			var ids []int64
			for _, in := range detectNotificationChurn(msgs, nil) {
				ids = append(ids, in.TaskID)
			}
			require.Equal(t, []int64{1, 2, 3, 5, 7, 9}, ids, "run %d", i)
		}
	})

	t.Run("the agents of a handoff loop are sorted, and so is its summary", func(t *testing.T) {
		var msgs []Message
		for i := 0; i < 6; i++ {
			msgs = append(msgs, pinMsg(int64(i+1), []string{"Zed", "Amy"}[i%2], "ping", i*20))
		}
		for i := 0; i < runs; i++ {
			got := detectRepetitiveHandoffs(msgs)
			require.Len(t, got, 1)
			require.Equal(t, []string{"Amy", "Zed"}, got[0].Agents, "run %d", i)
			require.Equal(t, "Rapid 6-message back-and-forth between Amy & Zed within 100s", got[0].Summary, "run %d", i)
		}
	})

	t.Run("the shared words of a duplicate pair are sorted", func(t *testing.T) {
		a := pinTask(1, "pending", 0)
		a.Title = "zulu yankee xray whiskey victor uniform"
		b := pinTask(2, "pending", 0)
		b.Title = "uniform victor whiskey xray yankee zulu"
		for i := 0; i < runs; i++ {
			got := detectDuplicateScopeCandidates([]Task{a, b})
			require.Len(t, got, 1)
			require.Equal(t, []string{"uniform", "victor", "whiskey", "xray", "yankee", "zulu"}, got[0].SharedWords, "run %d", i)
		}
	})
}

// A reassignment is a message, not a task: its event has no task id, and the Markdown shows a dash where it used to show #0 (#8292). The JSON keeps task_id 0.
func TestPinMarkdownIdlessEventHasNoTaskNumber(t *testing.T) {
	msgs := []Message{pinMsg(1, "Orchestrator", "Task 4 reassigned to Dev", 10)}
	r := Analyze(nil, msgs, nil, ReportFilter{Board: "b"}, pinTime(60))
	md := FormatMarkdown(r)
	assert.Contains(t, md, "| — | `reassignment` | Orchestrator | Task 4 reassigned to Dev |")
	assert.NotContains(t, md, "#0")
	// a task's own events keep their number
	c := pinTask(7, "cancelled", 0)
	md = FormatMarkdown(Analyze([]Task{c}, nil, nil, ReportFilter{}, pinTime(60)))
	assert.Contains(t, md, "| #7 | `cancellation` |")
}

func TestPinMarkdownReviewHeldSlots(t *testing.T) {
	review := pinTask(2, "in_progress", 0)
	review.Title = "Review the importer"
	review.AssignedTo = strPtr("Reviewer")
	review.ClaimedAt = strPtr(pinAt(1000))
	review.Workflow = &TaskWorkflow{CompletionReview: &CompletionReview{ReviewerRole: "QA", Status: "pending"}}
	md := FormatMarkdown(Analyze([]Task{review}, nil, nil, ReportFilter{}, pinTime(3600)))
	assert.Contains(t, md, "### E. Review-Held Slots\n\n")
	assert.Contains(t, md, "| Task ID | Title | Assignee | Reviewer Role | Held For |\n| :---: | :--- | :--- | :--- | :---: |\n| #2 | Review the importer | Reviewer | QA | 2600s |\n")
	assert.Contains(t, md, "Review-held slots: 1 task(s) hold a slot while a completion review is pending (longest: task #2, 2600s, reviewer QA).")
	// no review, no section
	md = FormatMarkdown(Analyze([]Task{pinTask(1, "pending", 0)}, nil, nil, ReportFilter{}, pinTime(10)))
	assert.NotContains(t, md, "Review-Held Slots")
	assert.NotContains(t, md, "Review-held slots:")
}

func TestPinMarkdownHandoffLoops(t *testing.T) {
	var msgs []Message
	for i := 0; i < 6; i++ {
		msgs = append(msgs, pinMsg(int64(i+1), []string{"Zed", "Amy"}[i%2], "ping", i*20))
	}
	md := FormatMarkdown(Analyze(nil, msgs, nil, ReportFilter{}, pinTime(600)))
	assert.Contains(t, md, "### F. Repetitive Handoff Loops\n\n")
	assert.Contains(t, md, "| Agents | Messages | Time Span | Window (UTC) |\n| :--- | :---: | :---: | :--- |\n| Amy & Zed | 6 | 100s | 06:00:00 – 06:01:40 |\n")
	assert.Contains(t, md, "Repetitive handoff loops: 1 rapid back-and-forth exchange(s) between the same two agents; the first: Rapid 6-message back-and-forth between Amy & Zed within 100s.")
	md = FormatMarkdown(Analyze(nil, msgs[:3], nil, ReportFilter{}, pinTime(600)))
	assert.NotContains(t, md, "Repetitive Handoff Loops")
	assert.NotContains(t, md, "Repetitive handoff loops:")
}
