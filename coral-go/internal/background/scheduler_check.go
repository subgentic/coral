package background

import (
	"context"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	"time"
)

func (s *JobScheduler) SetCheckDeliveryFn(fn func(context.Context, store.ScheduledJob, int64) error) {
	s.checkDeliveryFn = fn
}
func (s *JobScheduler) SetCheckPollFn(fn func(context.Context)) { s.checkPollFn = fn }
func (s *JobScheduler) deliverCheckRun(runID int64, job store.ScheduledJob) {
	s.watching.Add(1)
	go func() {
		defer s.watching.Done()
		defer safego.Recover("background/check delivery")
		base := s.parentCtx
		if base == nil {
			base = context.Background()
		}
		ctx, cancel := context.WithTimeout(base, 2*time.Minute)
		defer cancel()
		s.runningMu.Lock()
		s.running[runID] = cancel
		s.runningMu.Unlock()
		defer func() { s.runningMu.Lock(); delete(s.running, runID); s.runningMu.Unlock() }()
		state, reason, code := "failed", "check delivery interrupted; inspect its trigger", "check_delivery_failed"
		// Persist a failure even if an adapter panics; recovery alone would leave
		// the run active until the next process restart.
		defer func() {
			done, stop := context.WithTimeout(context.WithoutCancel(base), 5*time.Second)
			defer stop()
			s.store.FinishScheduledRunIfActive(done, runID, state, reason, reason, code, time.Now().UTC().Format(store.ISOFormat))
		}()
		if s.checkDeliveryFn == nil {
			state, reason, code = "failed", "check delivery is unavailable", "check_unavailable"
		} else if err := s.checkDeliveryFn(ctx, job, runID); err != nil {
			state, reason, code = "failed", "check delivery failed; inspect its trigger", "check_delivery_failed"
		} else {
			state, reason, code = "completed", "check sent to board", ""
		}
	}()
}
