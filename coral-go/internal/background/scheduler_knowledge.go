package background

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"time"

	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
)

// knowledgeJobTimeout bounds one distilling run: three passes over a team, each call with its own timeout.
const knowledgeJobTimeout = 45 * time.Minute

// SetKnowledgeRunFn gives the scheduler the body of a "knowledge" job (#13928): it distills a team's knowledge in the server, no agent is started (like a check).
func (s *JobScheduler) SetKnowledgeRunFn(fn func(context.Context, store.ScheduledJob, int64) AutoResult) {
	s.knowledgeRunFn = fn
}

// runKnowledgeJob runs a knowledge job's body and ends its run row with the result: completed or failed, in the body's fixed words and code. A manual run that completes also resumes a job the scheduler
// paused after repeated failures: the switch alone never clears that pause (Security's note on #13928).
func (s *JobScheduler) runKnowledgeJob(runID int64, job store.ScheduledJob, trigger string) {
	s.watching.Add(1)
	go func() {
		defer safego.Recover("background/knowledge job")
		defer s.watching.Done()
		base := s.parentCtx
		if base == nil {
			base = context.Background()
		}
		ctx, cancel := context.WithTimeout(base, knowledgeJobTimeout)
		defer cancel()
		s.runningMu.Lock()
		s.running[runID] = cancel
		s.runningMu.Unlock()
		defer func() { s.runningMu.Lock(); delete(s.running, runID); s.runningMu.Unlock() }()
		res := AutoResult{State: "failed", Reason: "the run was interrupted", Code: AutoCodeFailed}
		defer func() {
			done, stop := context.WithTimeout(context.WithoutCancel(base), 5*time.Second)
			defer stop()
			errMsg := ""
			if res.State == "failed" {
				errMsg = res.Reason
			}
			s.store.FinishScheduledRunIfActive(done, runID, res.State, res.Reason, errMsg, res.Code, time.Now().UTC().Format(store.ISOFormat))
			if res.State == "completed" && trigger == store.TriggerManual && job.PausedReason != "" {
				_, _ = s.store.UpdateScheduledJob(done, job.ID, map[string]interface{}{"enabled": 1, "paused_reason": ""})
			}
		}()
		if s.knowledgeRunFn == nil {
			res = AutoResult{State: "failed", Reason: "distilling is unavailable", Code: AutoCodeFailed}
			return
		}
		res = s.knowledgeRunFn(ctx, job, runID)
	}()
}

// NewKnowledgeJob is the one job a team's daily distilling is: the server builds it, nothing of it comes from a request but the team. It runs at 03:30 plus a minute of the team's own (up to half an hour,
// so teams do not all start together), in the time zone of this computer when the TZ variable names one, else UTC.
func NewKnowledgeJob(team string) store.ScheduledJob {
	sum := sha256.Sum256([]byte(team))
	tz := "UTC"
	if name := os.Getenv("TZ"); name != "" {
		if _, err := time.LoadLocation(name); err == nil {
			tz = name
		}
	}
	return store.ScheduledJob{
		Name:         "Distill team knowledge: " + team,
		Description:  "Distills what the team's agents learned into its knowledge, once a day, when something new was said. It writes a candidate for a person to accept.",
		CronExpr:     fmt.Sprintf("%d 3 * * *", 30+int(sum[0])%30),
		Timezone:     tz,
		AgentType:    "claude",
		JobType:      "knowledge",
		TeamName:     team,
		Enabled:      1,
		MaxDurationS: int(knowledgeJobTimeout / time.Second),
	}
}
