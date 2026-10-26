package background

import (
	"context"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
)

// adoptedRunPoll is how often a run adopted at startup is checked for its agent having ended (a variable for the tests).
var adoptedRunPoll = 30 * time.Second

// reapStaleRuns settles the runs a previous Coral left in pending or running (#6898). A run is advanced and watched only by in-process goroutines, so a restart leaves each of them behind, and the next
// slots of its job are skipped as "already running" until something finishes it. At startup, for each such run:
//   - one older than twice its job's longest allowed run is killed as before (timeout_reap, and its agent with it);
//   - one that never launched an agent (no session) is failed: Coral restarted before its agent existed;
//   - one whose agent has ended while Coral was down is completed (agent_done);
//   - one whose agent is still alive is adopted: watched again until the agent ends (completed) or the run's time is up (killed, timeout), as an in-process run is.
//
// What an adopted run does not redo is the work only its first goroutine held: removing its worktree, the auto-accept registration, an agent-exit judgement.
func (s *JobScheduler) reapStaleRuns(ctx context.Context) {
	activeRuns, err := s.store.ListActiveRuns(ctx)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	for _, run := range activeRuns {
		job, err := s.store.GetScheduledJob(ctx, run.JobID)
		if err != nil || job == nil {
			continue
		}
		maxDur := time.Duration(job.MaxDurationS) * time.Second
		if maxDur == 0 {
			maxDur = time.Hour
		}
		hasSession := run.SessionID != nil && *run.SessionID != ""
		var started time.Time
		hasStart := false
		if run.StartedAt != nil {
			if t, perr := parseTimestamp(*run.StartedAt); perr == nil {
				started, hasStart = t, true
			}
		}
		finish := func(status, reason, msg string) {
			fields := map[string]interface{}{"status": status, "exit_reason": reason, "finished_at": now.Format(store.ISOFormat)}
			if msg != "" {
				fields["error_msg"] = msg
			}
			s.store.UpdateScheduledRun(ctx, run.ID, fields)
		}
		switch {
		case hasStart && now.Sub(started) > maxDur*2: // generous 2x buffer
			s.logger.Warn("reaping stale run", "run_id", run.ID, "elapsed", now.Sub(started))
			s.killRunSession(ctx, &run, s.runAgentType(ctx, run, job.AgentType))
			finish("killed", "timeout_reap", "")
			s.cleanupSettledWorktree(ctx, run, *job)
		case !hasSession:
			s.logger.Warn("a run left over from before Coral restarted never launched its agent", "run_id", run.ID)
			finish("failed", "interrupted_by_restart", "Coral restarted before this run launched its agent")
		case !hasStart:
			continue
		case !s.agentAlive(ctx, run, job.AgentType):
			s.logger.Info("a run's agent ended while Coral was down", "run_id", run.ID)
			// "agent_done" only when its last event shows it finished: it may have crashed while Coral was down, and the run history must not claim a success it never saw.
			reason := "agent_done"
			if s.lastEventType != nil {
				last, stopFailed := s.lastEventType(ctx, *run.SessionID)
				if last == "" && !stopFailed && reportsEvents(s.runAgentType(ctx, run, job.AgentType)) { // no event from the agent at all (a read that failed is not this: it comes back as a failed stop): it never started, which is not "completed" (#6978, Codex Test's 07:10 run)
					s.logger.Warn("a run's agent ended without ever reporting", "run_id", run.ID)
					finish("failed", agentNeverStartedCode, agentNeverStartedMsg)
					s.store.UpdateScheduledRun(ctx, run.ID, map[string]interface{}{"error_code": agentNeverStartedCode})
					s.cleanupSettledWorktree(ctx, run, *job)
					continue
				}
				if (last != "stop" && last != "session_end") || stopFailed { // a stop that is a failed turn (StopFailure: an API error) is not a finish
					reason = "ended_while_coral_was_down"
				}
			}
			finish("completed", reason, "")
			s.cleanupSettledWorktree(ctx, run, *job)
		default:
			if s.settleAdoptedOnTurn(ctx, run, *job) { // its agent is alive but finished its turn while Coral was down (#7090)
				continue
			}
			s.adoptRun(ctx, run, *job, started.Add(maxDur))
		}
	}
}

// agentAlive reports whether the run's agent session still exists; with no runtime to ask it is taken as alive (the run is then watched, not finished on a guess).
func (s *JobScheduler) agentAlive(ctx context.Context, run store.ScheduledRun, agentType string) bool {
	if s.runtime == nil || run.SessionID == nil {
		return true
	}
	return s.runtime.IsAlive(ctx, s.runAgentType(ctx, run, agentType)+"-"+*run.SessionID)
}

// runAgentType is the agent type the run's session was started as: the type on its session row, else the job's (else Claude). A job's agent type edited since the run started would otherwise name a session that
// never existed, and a live agent would be read as gone (Security's LOW on #6904).
func (s *JobScheduler) runAgentType(ctx context.Context, run store.ScheduledRun, jobType string) string {
	if s.sessionStore != nil && run.SessionID != nil {
		if ls, err := s.sessionStore.GetLiveSession(ctx, *run.SessionID); err == nil && ls != nil && ls.AgentType != "" {
			return ls.AgentType
		}
	}
	if jobType == "" {
		return at.Claude
	}
	return jobType
}

// adoptRun watches a run whose agent outlived the previous Coral, as launchAndWatch's launch function does for a run it started: until the agent ends (completed) or deadline passes (killed, timeout). A shutdown
// leaves the run as it is for the next start to settle again.
func (s *JobScheduler) adoptRun(ctx context.Context, run store.ScheduledRun, job store.ScheduledJob, deadline time.Time) {
	s.logger.Info("adopting a run whose agent outlived the previous Coral", "run_id", run.ID, "until", deadline.Format(time.RFC3339))
	s.watching.Add(1)
	go func() {
		defer safego.Recover("background/scheduler:adoptRun")
		defer s.watching.Done()
		ticker := time.NewTicker(adoptedRunPoll)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if s.settleAdoptedOnTurn(ctx, run, job) {
					return
				}
				if !s.agentAlive(ctx, run, job.AgentType) {
					s.finishRun(ctx, run.ID, job, "completed", "agent_done", false)
					s.cleanupSettledWorktree(ctx, run, job)
					return
				}
				if time.Now().After(deadline) {
					s.finishRun(ctx, run.ID, job, "killed", "timeout", false) // finishRun ends its agent
					s.cleanupSettledWorktree(ctx, run, job)
					return
				}
			}
		}
	}()
}
