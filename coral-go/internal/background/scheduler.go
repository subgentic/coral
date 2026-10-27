package background

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentsignin"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
)

// parseTimestamp parses a timestamp string, trying store.ISOFormat (with microseconds) first,
// then falling back to time.RFC3339 for backwards compatibility.
func parseTimestamp(s string) (time.Time, error) {
	if t, err := time.Parse(store.ISOFormat, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}

// lookbackStart is the time after which a job's next slot counts as due. It
// starts from the last run (or 24h ago for a job that never ran), so a slot
// missed while Coral was down is caught up once. It never reaches back past
// the job's last change (updated_at: creation, an edit, or pause/resume): a
// job created at 10:00 for "weekdays 9:00" waits for tomorrow's 9:00 instead
// of firing at once, and a resumed job does not fire the slots it missed
// while paused (#3136).
func lookbackStart(job store.ScheduledJob, lastRun *store.ScheduledRun, now time.Time) time.Time {
	after := now.Add(-24 * time.Hour)
	if lastRun != nil {
		if t, err := parseTimestamp(lastRun.ScheduledAt); err == nil {
			after = t
		}
	}
	changed := job.UpdatedAt
	if changed == "" {
		changed = job.CreatedAt
	}
	if t, err := parseTimestamp(changed); err == nil && t.After(after) {
		after = t
	}
	return after
}

// jobFailurePauseAfter is how many failed runs in a row pause a job.
const jobFailurePauseAfter = 3

// pauseIfFailing pauses job when its last jobFailurePauseAfter runs all
// failed, recording why (the newest error) so the Jobs view can show it; the
// job then waits until someone fixes and resumes it (#3171). Reports whether
// it paused the job.
func (s *JobScheduler) pauseIfFailing(ctx context.Context, job store.ScheduledJob) bool {
	runs, err := s.store.GetRunsForJob(ctx, job.ID, jobFailurePauseAfter)
	if err != nil || len(runs) < jobFailurePauseAfter {
		return false
	}
	resumed, hasResume := time.Time{}, false
	if job.ResumedAt != "" {
		if t, err := parseTimestamp(job.ResumedAt); err == nil {
			resumed, hasResume = t, true
		}
	}
	for _, r := range runs {
		if r.Status != "failed" {
			return false
		}
		// A run refused because the agent CLI was signed out says nothing about the job: it does not count toward the pause, and the job runs again once signed in (#5469).
		if r.ErrorCode != nil && store.IsSignInRefusalCode(*r.ErrorCode) {
			return false
		}
		// A run from before the job was resumed does not count: the user fixed
		// the cause and resumed it, so it gets its runs again (#3171 review).
		if hasResume {
			if t, err := parseTimestamp(r.ScheduledAt); err != nil || !t.After(resumed) {
				return false
			}
		}
	}
	reason := fmt.Sprintf("Paused after %d failed runs in a row", jobFailurePauseAfter)
	if e := runs[0].ErrorMsg; e != nil && strings.TrimSpace(*e) != "" {
		reason += ": " + strings.TrimSpace(*e)
	}
	if _, err := s.store.UpdateScheduledJob(ctx, job.ID, map[string]interface{}{"enabled": 0, "paused_reason": reason}); err != nil {
		return false
	}
	s.logger.Warn("job paused after repeated failures", "job", job.Name, "reason", reason)
	return true
}

// ConcurrencyLimitError is returned when the max concurrent run limit is reached.
type ConcurrencyLimitError struct {
	Limit int
}

func (e *ConcurrencyLimitError) Error() string {
	return fmt.Sprintf("Concurrent task limit reached (max: %d). Try again later.", e.Limit)
}

// JobScheduler polls scheduled_jobs, fires due runs, and manages watchdog goroutines.
type JobScheduler struct {
	store          *store.ScheduleStore
	sessionStore   *store.SessionStore
	lastEventType  func(ctx context.Context, sessionID string) (last string, stopFailed bool) // the type of the agent's last event (stop, tool_use...), "" for none, and whether a stop was a failed turn (an API error); nil: not known (#6898)
	hasEvents      func(ctx context.Context, sessionID string) bool                           // whether the agent's CLI reported anything (its hook events); nil: a run is never judged by it (#6842)
	runtime        AgentRuntime
	maxConcurrent  int
	interval       time.Duration
	logger         *slog.Logger
	parentCtx      context.Context // set by Run(); used by launchAndWatch for shutdown
	runningMu      sync.Mutex
	running        map[int64]context.CancelFunc // run_id -> cancel func for watchdog
	watching       sync.WaitGroup               // the launchAndWatch goroutines
	launchFn       func(ctx context.Context, job store.ScheduledJob, runID int64) error
	nextFireTimeFn func(cronExpr, tz string, after time.Time) (time.Time, error)
	worktreeRoot   string // where run worktrees go (Coral's data dir); "" = beside the repo (legacy)
	workflowRunner *WorkflowRunner
	workflowStore  *store.WorkflowStore
	sessionTurn    func(ctx context.Context, sessionID string) (store.RunTurn, error) // how a session's current turn stands (#7090); nil: no run is finished by its turn
	turnEnded      sync.Map                                                           // run_id -> whether its agent was gone, for a run settled on its turn and not yet cleaned up
}

// NewJobScheduler creates a new JobScheduler.
func NewJobScheduler(schedStore *store.ScheduleStore, interval time.Duration) *JobScheduler {
	maxConcurrent := 5
	if v := os.Getenv("CORAL_MAX_CONCURRENT_JOBS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			maxConcurrent = n
		}
	}
	return &JobScheduler{
		store:         schedStore,
		maxConcurrent: maxConcurrent,
		interval:      interval,
		logger:        slog.Default().With("service", "job_scheduler"),
		running:       make(map[int64]context.CancelFunc),
	}
}

// SetLaunchFn sets the function called to launch an agent for a job run.
func (s *JobScheduler) SetLaunchFn(fn func(ctx context.Context, job store.ScheduledJob, runID int64) error) {
	s.launchFn = fn
}

// SetSessionStore sets the session store used for tagging sessions.
func (s *JobScheduler) SetSessionStore(ss *store.SessionStore) {
	s.sessionStore = ss
}

// SetRuntime sets the agent runtime used for killing sessions.
func (s *JobScheduler) SetRuntime(rt AgentRuntime) {
	s.runtime = rt
}

// SetWorkflowRunner sets the workflow runner and store for workflow-type jobs.
func (s *JobScheduler) SetWorkflowRunner(wr *WorkflowRunner, ws *store.WorkflowStore) {
	s.workflowRunner = wr
	s.workflowStore = ws
}

// SetWorktreeRoot sets the directory run worktrees are created under (the
// "worktrees" directory in Coral's data dir), instead of beside the user's
// repository (#3171).
func (s *JobScheduler) SetWorktreeRoot(dir string) {
	s.worktreeRoot = dir
}

// SetNextFireTimeFn sets the cron evaluation function.
func (s *JobScheduler) SetNextFireTimeFn(fn func(cronExpr, tz string, after time.Time) (time.Time, error)) {
	s.nextFireTimeFn = fn
}

// Run starts the scheduler loop.
func (s *JobScheduler) Run(ctx context.Context) error {
	s.parentCtx = ctx // store for launchAndWatch goroutines
	s.logger.Info("scheduler started", "interval", s.interval, "max_concurrent", s.maxConcurrent)

	// Reap stale runs from a previous crash
	s.reapStaleRuns(ctx)

	return runOnTicker(ctx, s.interval, func() {
		if err := s.tick(ctx); err != nil {
			s.logger.Error("tick error", "error", err)
		}
	})
}

func (s *JobScheduler) tick(ctx context.Context) error {
	if s.nextFireTimeFn == nil {
		return nil // No cron evaluator configured
	}

	jobs, err := s.store.ListScheduledJobs(ctx, true)
	if err != nil {
		return err
	}

	nowUTC := time.Now().UTC()
	for _, job := range jobs {
		if job.Name == "__oneshot__" {
			continue
		}
		if err := s.evaluateJob(ctx, job, nowUTC); err != nil {
			s.logger.Error("job evaluation error", "job", job.Name, "error", err)
		}
	}

	// Clean up finished watchdog entries
	s.runningMu.Lock()
	for runID, cancel := range s.running {
		_ = cancel // Keep reference
		run, err := s.store.GetScheduledRun(ctx, runID)
		if err != nil || run == nil || (run.Status != "pending" && run.Status != "running") {
			delete(s.running, runID)
		}
	}
	s.runningMu.Unlock()

	return nil
}

func (s *JobScheduler) evaluateJob(ctx context.Context, job store.ScheduledJob, now time.Time) error {
	// Check if there's already an active run
	active, err := s.store.GetActiveRunForJob(ctx, job.ID)
	if err != nil {
		return err
	}
	if active != nil {
		return nil // Already running
	}

	// Check last run
	lastRun, err := s.store.GetLastRunForJob(ctx, job.ID)
	if err != nil {
		return err
	}

	// A job that keeps failing pauses itself, with the reason shown (#3171).
	if lastRun != nil && lastRun.Status == "failed" && s.pauseIfFailing(ctx, job) {
		return nil
	}

	// Calculate next fire time. A run a person started (Run now) does not move the schedule: the next slot is counted from the last run the
	// schedule made.
	lastSlot, err := s.store.GetLastCronRunForJob(ctx, job.ID)
	if err != nil {
		return err
	}
	afterTime := lookbackStart(job, lastSlot, now)

	nextFire, err := s.nextFireTimeFn(job.CronExpr, job.Timezone, afterTime)
	if err != nil {
		return fmt.Errorf("cron parse error for job %s: %w", job.Name, err)
	}

	if nextFire.After(now) {
		return nil // Not due yet
	}

	if _, err := s.startRun(ctx, job, now, store.TriggerCron); err != nil {
		var full *ConcurrencyLimitError
		if errors.As(err, &full) || errors.Is(err, ErrJobRunning) {
			return nil // At capacity, or a run began since the check above
		}
		return err
	}
	return nil
}

// ErrJobRunning: the job already has a run pending or running.
var ErrJobRunning = errors.New("the job is already running")

// ErrJobNotFound: no job has that id.
var ErrJobNotFound = errors.New("job not found")

// RunNow runs a job once now, at a person's request (#9293): the same run the schedule would make (a run record, the workflow or the agent,
// the same watching), recorded as the job's run with trigger "manual". It works for a paused job (the person asked for it), refuses a job
// that is already running, and does not move the job's schedule. Returns the run's id; *ConcurrencyLimitError when the scheduler is full.
func (s *JobScheduler) RunNow(ctx context.Context, jobID int64) (int64, error) {
	job, err := s.store.GetScheduledJob(ctx, jobID)
	if err != nil {
		return 0, err
	}
	if job == nil {
		return 0, ErrJobNotFound
	}
	return s.startRun(ctx, *job, time.Now().UTC(), store.TriggerManual)
}

// startRun makes a run record for job, taking a place among the running ones, and starts it. The record is made while the lock is held, so
// two callers cannot both start a job that has no run yet.
func (s *JobScheduler) startRun(ctx context.Context, job store.ScheduledJob, now time.Time, trigger string) (int64, error) {
	s.runningMu.Lock()
	if len(s.running) >= s.maxConcurrent {
		s.runningMu.Unlock()
		return 0, &ConcurrencyLimitError{Limit: s.maxConcurrent}
	}
	active, err := s.store.GetActiveRunForJob(ctx, job.ID)
	if err != nil {
		s.runningMu.Unlock()
		return 0, err
	}
	if active != nil {
		s.runningMu.Unlock()
		return 0, ErrJobRunning
	}

	// Create a run record while holding the lock
	runID, err := s.store.CreateScheduledRunTrigger(ctx, job.ID, now.Format(store.ISOFormat), "pending", trigger)
	if err != nil {
		s.runningMu.Unlock()
		return 0, err
	}

	// Pre-register placeholder so concurrent evaluateJob calls see it
	s.running[runID] = func() {}
	s.runningMu.Unlock()

	// Dispatch based on job type
	if job.JobType == "workflow" && job.WorkflowID != nil {
		go func() {
			defer safego.Recover("background/scheduler:s.triggerWorkflowForJob")
			s.triggerWorkflowForJob(runID, job, trigger)
		}()
	} else if s.launchFn != nil {
		rc := runConfig{
			repoPath:        job.RepoPath,
			baseBranch:      job.BaseBranch,
			maxDurationS:    job.MaxDurationS,
			cleanupWorktree: job.CleanupWorktree == 1,
			createWorktree:  true,
			tag:             "scheduled",
		}
		s.watch(runID, job, rc)
	}
	return runID, nil
}

// runConfig holds launch parameters for a run.
type runConfig struct {
	repoPath        string
	baseBranch      string
	maxDurationS    int
	cleanupWorktree bool
	createWorktree  bool
	tag             string // "scheduled" or "task"
}

// FireOneshot submits a one-shot task run from the API.
// Returns the run_id. Returns ConcurrencyLimitError if at capacity.
func (s *JobScheduler) FireOneshot(ctx context.Context, config map[string]interface{}) (int64, error) {
	s.runningMu.Lock()
	if len(s.running) >= s.maxConcurrent {
		s.runningMu.Unlock()
		return 0, &ConcurrencyLimitError{Limit: s.maxConcurrent}
	}
	s.runningMu.Unlock()

	now := time.Now().UTC().Format(store.ISOFormat)
	var displayName *string
	if v, ok := config["display_name"].(string); ok && v != "" {
		displayName = &v
	}

	runID, err := s.store.CreateOneshotRun(ctx, now, displayName)
	if err != nil {
		return 0, err
	}

	repoPath, _ := config["repo_path"].(string)
	baseBranch, _ := config["base_branch"].(string) // empty: the repository's current branch, chosen when the run's worktree is made (#6701)
	maxDur, _ := config["max_duration_s"].(float64)
	if maxDur == 0 {
		maxDur = 3600
	}
	createWT, _ := config["create_worktree"].(bool)
	cleanupWT, _ := config["cleanup_worktree"].(bool)

	// Build a synthetic ScheduledJob for the launch function
	prompt, _ := config["prompt"].(string)
	agentType, _ := config["agent_type"].(string)
	if agentType == "" {
		agentType = at.Claude
	}
	flags, _ := config["flags"].(string)
	// Not "Task #N": board tasks are numbered #N too (#3171).
	dn := fmt.Sprintf("Job run %d", runID)
	if displayName != nil {
		dn = *displayName
	}

	job := store.ScheduledJob{
		RepoPath:   repoPath,
		BaseBranch: baseBranch,
		Prompt:     prompt,
		AgentType:  agentType,
		Flags:      flags,
		Name:       dn,
	}

	rc := runConfig{
		repoPath:        repoPath,
		baseBranch:      baseBranch,
		maxDurationS:    int(maxDur),
		cleanupWorktree: cleanupWT,
		createWorktree:  createWT,
		tag:             "task",
	}

	s.watch(runID, job, rc)
	return runID, nil
}

// KillRun kills a running task by run_id. Returns true if killed.
func (s *JobScheduler) KillRun(ctx context.Context, runID int64) bool {
	run, err := s.store.GetScheduledRun(ctx, runID)
	if err != nil || run == nil || (run.Status != "pending" && run.Status != "running") {
		return false
	}

	// Kill the agent session if we have a session_id
	agentType := at.Claude
	if job, err := s.store.GetScheduledJob(ctx, run.JobID); err == nil && job != nil {
		agentType = job.AgentType
	}
	s.killRunSession(ctx, run, agentType)

	now := time.Now().UTC().Format(store.ISOFormat)
	if won, err := s.store.FinishScheduledRunIfActive(ctx, runID, "killed", "user_cancelled", "", "", now); err == nil && !won {
		return false // the run was settled by something else while it was being killed (#7090)
	}

	// Cancel watchdog goroutine if tracked
	s.runningMu.Lock()
	if cancel, ok := s.running[runID]; ok {
		cancel()
		delete(s.running, runID)
	}
	s.runningMu.Unlock()

	return true
}

// killRunSession kills the agent session a run launched, if it recorded one.
func (s *JobScheduler) killRunSession(ctx context.Context, run *store.ScheduledRun, agentType string) {
	if run == nil || run.SessionID == nil || *run.SessionID == "" || s.runtime == nil {
		return
	}
	if agentType == "" {
		agentType = at.Claude
	}
	name := agentType + "-" + *run.SessionID
	if err := s.runtime.KillAgent(ctx, name); err != nil {
		s.logger.Warn("could not kill the run's agent", "run_id", run.ID, "session", name, "error", err)
	}
	if s.sessionStore != nil { // ended like a killed session: its live row is no longer active (a run's agent that is killed here left it "active" with no stopped_at, #7016)
		if err := s.sessionStore.UnregisterLiveSession(ctx, *run.SessionID); err != nil {
			s.logger.Warn("could not end the run's session row", "run_id", run.ID, "session", name, "error", err)
		}
	}
}

// launchAndWatch is the core goroutine that creates worktrees, launches agents,
// monitors via watchdog, fires webhooks, and cleans up.
// watch runs launchAndWatch on its own goroutine, counted so waitWatchers can wait for it.
func (s *JobScheduler) watch(runID int64, job store.ScheduledJob, rc runConfig) {
	s.watching.Add(1)
	go func() {
		defer safego.Recover("background/scheduler:609")
		defer s.watching.Done()
		s.launchAndWatch(runID, job, rc)
	}()
}

// waitWatchers waits until every run's launchAndWatch has returned, its final status
// written (tests: a kill's own status must still stand once the watchdog is done, #3788).
func (s *JobScheduler) waitWatchers() { s.watching.Wait() }

// shuttingDown reports whether Coral is stopping: the scheduler's context is done. A run's own deadline and a user's kill cancel the run's context, not this one.
func (s *JobScheduler) shuttingDown() bool { return s.parentCtx != nil && s.parentCtx.Err() != nil }

// WaitWatchers is the shutdown's wait for the run goroutines to return, so the process does not exit while one is still running its end-of-run code. It waits at most d, and only once the scheduler's context is
// done (while Coral runs on, runs go on and there is nothing to wait for). It reports false only when it gave up with a run goroutine still going.
func (s *JobScheduler) WaitWatchers(d time.Duration) bool {
	if s.parentCtx == nil || s.parentCtx.Err() == nil {
		return true
	}
	done := make(chan struct{})
	safego.Go("background/scheduler:WaitWatchers", func() { s.watching.Wait(); close(done) })
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

func (s *JobScheduler) launchAndWatch(runID int64, job store.ScheduledJob, rc runConfig) {
	// Use the scheduler's parent context so goroutines cancel on shutdown.
	// Falls back to Background if Run() hasn't been called (e.g., FireOneshot).
	ctx := s.parentCtx
	if ctx == nil {
		ctx = context.Background()
	}
	maxDur := rc.maxDurationS
	if maxDur == 0 {
		maxDur = 3600
	}

	watchCtx, cancel := context.WithTimeout(ctx, time.Duration(maxDur)*time.Second)
	defer cancel()

	s.runningMu.Lock()
	s.running[runID] = cancel
	s.runningMu.Unlock()

	defer func() {
		s.runningMu.Lock()
		delete(s.running, runID)
		s.runningMu.Unlock()
	}()

	// A scheduled run of a signed-out agent CLI is refused before anything is made for it (#5469): no worktree, no launch, and no sign-in flow in a tmux pane nobody watches.
	if rc.tag == "scheduled" && s.refuseIfNotSignedIn(ctx, runID, job) {
		return
	}

	wt, ok := s.prepareRunWorktree(ctx, watchCtx, runID, rc)
	if !ok {
		return
	}

	// Update run with worktree path
	startedAt := time.Now().UTC().Format(store.ISOFormat)
	s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
		"status":        "running",
		"started_at":    startedAt,
		"worktree_path": wt.workingDir,
	})

	// Launch the agent via the configured launch function
	var launchErr error
	var neverStarted atomic.Bool
	if rc.tag == "scheduled" {
		s.startTurnWatch(watchCtx, runID, job) // a scheduled prompt run finishes on its agent's accepted turn end (#7090)
	}
	if s.launchFn != nil {
		safego.Go("background/scheduler:watchNeverStarted", func() { s.watchNeverStarted(watchCtx, cancel, runID, job, &neverStarted) })
		// Pass the working dir via a modified job
		jobCopy := job
		jobCopy.RepoPath = wt.workingDir
		launchErr = s.launchFn(watchCtx, jobCopy, runID)
	}
	if s.shuttingDown() { // Coral is shutting down, not the run ending (its own deadline and a user's kill cancel watchCtx, not this): the agent outlives Coral and is still working in its worktree, so nothing is finished, removed or written, and the next start settles or adopts the run (#6918, #6911)
		return
	}
	if launchErr == nil {
		s.afterLaunch(ctx, runID, job, rc)
	}

	if settled, gone := s.takeTurnEnded(runID); settled {
		// The run was finished by its agent's turn end: the outcome is recorded, and the worktree goes only if the agent's process is.
		if rc.cleanupWorktree && wt.worktreeDir != "" && gone {
			s.cleanupWorktree(rc.repoPath, wt.worktreeDir, wt.runBranch, wt.baseBranch)
		}
		return
	}
	status, exitReason := runOutcome(launchErr, watchCtx.Err())
	if neverStarted.Load() && status == "failed" { // the backstop ended the run: its own sentence and code, not "context canceled" (#6978)
		exitReason = agentNeverStartedCode // the code in exit_reason, the sentence in error_msg, on every path (the startup settle's shape, #7016)
		s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{"error_msg": agentNeverStartedMsg, "error_code": agentNeverStartedCode})
	}
	if status == "failed" && errors.Is(launchErr, ptymanager.ErrStartCommand) { // one plain sentence and a fixed code, not "spawn agent failed: ..." (#6978)
		exitReason = startCommandFailedCode
		s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{"error_msg": ptymanager.ErrStartCommand.Error(), "error_code": startCommandFailedCode})
	}
	if status == "completed" && s.exitedBeforeStarting(ctx, runID, job, time.Now().UTC().Format(store.ISOFormat), startedAt) {
		status, exitReason = "failed", agentExitedEarlyCode // the sentence is in error_msg (exitedBeforeStarting)
	}
	s.finishRun(ctx, runID, job, status, exitReason, launchErr != nil)

	// Cleanup worktree if configured
	if rc.cleanupWorktree && wt.worktreeDir != "" {
		s.cleanupWorktree(rc.repoPath, wt.worktreeDir, wt.runBranch, wt.baseBranch)
	}
}

// SetEventCheck tells the scheduler how to ask whether an agent's CLI reported anything (a stored hook event), the signal that it started (the startup passes the task store's read).
func (s *JobScheduler) SetEventCheck(fn func(ctx context.Context, sessionID string) bool) {
	s.hasEvents = fn
}

// SetLastEventType tells the scheduler how to read the type of an agent's last stored event and whether it was a failed stop (the startup passes the task store's reads): a run whose agent ended while Coral was down
// is recorded finished only when that event shows the agent ended its work (a stop that did not fail, session_end).
func (s *JobScheduler) SetLastEventType(fn func(ctx context.Context, sessionID string) (last string, stopFailed bool)) {
	s.lastEventType = fn
}

// reportsEvents says whether an agent type's CLI reports hook events, the signal that it started: Claude and Codex do (and an empty type is Claude). Pi and Gemini install no hooks, so a run of theirs with no event is the
// normal case, never "the agent never started" (#6978, Security Windows's and QA's round 4): the backstop, the early-exit check and the startup settle all ask here.
func reportsEvents(agentType string) bool {
	return agentType == "claude" || agentType == "codex" || agentType == ""
}

// startCommandFailedCode is the run's fixed error_code when Coral could not hand the agent its start command (#6978).
const startCommandFailedCode = "start_command_failed"

const (
	agentNeverStartedMsg  = "the agent never started: its terminal sat at an idle shell and reported nothing"
	agentNeverStartedCode = "agent_never_started"
)

// neverStartedAfter is how long a run's terminal may sit at an idle shell with no event from the agent before the run is failed as never started, and neverStartedRecheck how often that is looked at (vars for the tests).
// A backstop for any cause of an idle shell that nothing else caught: a start command that could not be handed over (#6978), a shell that ate it, a CLI that failed before its first hook.
var (
	neverStartedAfter   = 3 * time.Minute
	neverStartedRecheck = 15 * time.Second
)

// watchNeverStarted fails a run whose agent never started: after neverStartedAfter, its pane is back at an idle shell (the CLI is not running) and the session has reported no event. It cancels the run's context (the launch
// function returns, the run is failed and its session killed, as for any failed launch) and sets neverStarted. It ends with the run. Only for a CLI that reports events (claude, codex) and a runtime that can say the shell is idle;
// anything it cannot tell leaves the run alone.
func (s *JobScheduler) watchNeverStarted(ctx context.Context, cancel context.CancelFunc, runID int64, job store.ScheduledJob, neverStarted *atomic.Bool) {
	if s.hasEvents == nil || !reportsEvents(job.AgentType) {
		return
	}
	checker, ok := s.runtime.(ptymanager.ShellIdleChecker)
	if !ok {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(neverStartedAfter):
	}
	ticker := time.NewTicker(neverStartedRecheck)
	defer ticker.Stop()
	for {
		run, err := s.store.GetScheduledRun(context.Background(), runID)
		if err == nil && run != nil && run.SessionID != nil && *run.SessionID != "" && run.Status == "running" {
			if s.hasEvents(ctx, *run.SessionID) {
				return // the agent started
			}
			agentType := job.AgentType
			if agentType == "" {
				agentType = "claude"
			}
			if idle, _, known := checker.AgentShellIdle(ctx, agentType+"-"+*run.SessionID, agentType, *run.SessionID); known && idle {
				s.logger.Warn("scheduled run: the agent never started", "run_id", runID, "job", job.Name)
				neverStarted.Store(true)
				cancel()
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// agentExitedEarlyWindow is how short a run must be, from its start to the agent's exit, to be judged by whether the agent ever reported anything.
var agentExitedEarlyWindow = 15 * time.Second

const (
	agentExitedEarlyMsg  = "the agent exited before it started: it ended within seconds without reporting anything"
	agentExitedEarlyCode = "agent_exited_before_start"
)

// exitedBeforeStarting reports whether a run that ended on its own did so before its agent started: within agentExitedEarlyWindow of the run's start, and its session never reported an event (Claude and Codex
// report through hooks from their first moment; a one-shot that ends fast on purpose has reported events by then). It records the plain reason and the fixed error_code on the run when it says yes. The runtime
// gives no exit code, so none is recorded. A scheduler with no event check, a CLI that reports no events (any other agent type), a run with no session, or a read that fails is never judged: it stays completed.
func (s *JobScheduler) exitedBeforeStarting(ctx context.Context, runID int64, job store.ScheduledJob, nowISO, startedISO string) bool {
	if s.hasEvents == nil || !reportsEvents(job.AgentType) {
		return false
	}
	started, err1 := time.Parse(store.ISOFormat, startedISO)
	now, err2 := time.Parse(store.ISOFormat, nowISO)
	if err1 != nil || err2 != nil || now.Sub(started) > agentExitedEarlyWindow {
		return false
	}
	run, err := s.store.GetScheduledRun(ctx, runID)
	if err != nil || run == nil || run.SessionID == nil || *run.SessionID == "" || run.Status == "killed" {
		return false
	}
	if s.hasEvents(ctx, *run.SessionID) {
		return false
	}
	s.logger.Warn("scheduled run: the agent exited before it started", "run_id", runID, "job", job.Name)
	s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{"error_msg": agentExitedEarlyMsg, "error_code": agentExitedEarlyCode})
	return true
}

// refuseIfNotSignedIn fails the scheduled run at once, with the sentence, the fixed error_code and the CLI named, when the job's agent CLI has a status command and is signed out. It
// reports whether it did. A CLI that cannot be found or asked does not stop the run here.
func (s *JobScheduler) refuseIfNotSignedIn(ctx context.Context, runID int64, job store.ScheduledJob) bool {
	if s.sessionStore == nil || !agentsignin.Supports(job.AgentType) {
		return false
	}
	settings, err := s.sessionStore.GetSettingsForCLI(ctx)
	if err != nil {
		return false
	}
	bin, err := agent.FindCLI(settings, job.AgentType)
	if err != nil {
		return false
	}
	var nsi *agentsignin.NotSignedInError
	if err := agentsignin.RequireFreshIn(ctx, job.AgentType, bin, job.RepoPath); !errors.As(err, &nsi) {
		return false
	}
	s.logger.Warn("scheduled run not started: "+nsi.Error(), "job", job.Name, "run_id", runID)
	s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
		"status": "failed", "error_msg": nsi.Error(), "exit_reason": nsi.Error(),
		"error_code": nsi.Code(), "agent_type": nsi.Agent,
		"finished_at": time.Now().UTC().Format(store.ISOFormat),
	})
	return true
}

// afterLaunch tags the launched session (e.g. "scheduled" or "task").
func (s *JobScheduler) afterLaunch(ctx context.Context, runID int64, job store.ScheduledJob, rc runConfig) {
	run, err := s.store.GetScheduledRun(ctx, runID)
	if err != nil || run == nil || run.SessionID == nil {
		return
	}
	if rc.tag != "" {
		s.tagSession(ctx, *run.SessionID, rc.tag)
	}
}

// runOutcome is a run's final status and reason: completed when the agent is done, failed with the launch's error,
// killed when it ran past its time.
func runOutcome(launchErr, watchErr error) (status, exitReason string) {
	status, exitReason = "completed", "agent_done"
	if launchErr != nil {
		status, exitReason = "failed", launchErr.Error()
	}
	if watchErr == context.DeadlineExceeded {
		status, exitReason = "killed", "timeout"
	}
	return status, exitReason
}

// finishRun records the run's outcome. A run that timed out or failed after launching must not leave its agent
// running (audit HIGH-02): its session is killed before the worktree is removed from under it. A user's kill
// (KillRun) has already killed it and recorded the kill, which the "failed" its cancel produces must not overwrite;
// a Coral shutdown cancels ctx itself, and agents outlive a restart, so neither kills here.
func (s *JobScheduler) finishRun(ctx context.Context, runID int64, job store.ScheduledJob, status, exitReason string, launchFailed bool) {
	now := time.Now().UTC().Format(store.ISOFormat)
	userKilled := false
	if run, err := s.store.GetScheduledRun(ctx, runID); err == nil && run != nil {
		userKilled = run.Status == "killed"
		if !userKilled && ctx.Err() == nil && (status == "killed" || launchFailed) {
			s.killRunSession(ctx, run, s.runAgentType(ctx, *run, job.AgentType))
		}
	}
	if !userKilled {
		// Only while the run is still active: a turn end, a kill or the deadline that settled it first is not overwritten (#7090).
		s.store.FinishScheduledRunIfActive(ctx, runID, status, exitReason, "", "", now)
	}
}

// tagSession ensures a tag exists and applies it to a session.
func (s *JobScheduler) tagSession(ctx context.Context, sessionID, tagName string) {
	if s.sessionStore == nil || tagName == "" {
		return
	}
	tags, err := s.sessionStore.ListTags(ctx)
	if err != nil {
		s.logger.Warn("failed to list tags for session tagging", "error", err)
		return
	}
	var tagID int64
	for _, t := range tags {
		if t.Name == tagName {
			tagID = t.ID
			break
		}
	}
	if tagID == 0 {
		// Create the tag with a default color
		color := "#f78166" // orange, matches Python default
		tag, err := s.sessionStore.CreateTag(ctx, tagName, color)
		if err != nil {
			s.logger.Warn("failed to create tag", "tag", tagName, "error", err)
			return
		}
		tagID = tag.ID
	}
	if err := s.sessionStore.AddSessionTag(ctx, sessionID, tagID); err != nil {
		s.logger.Warn("failed to tag session", "session_id", sessionID, "tag", tagName, "error", err)
	}
}
