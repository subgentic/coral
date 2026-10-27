package background

import (
	"context"
	"fmt"
	"time"

	"github.com/subgentic/coral/internal/store"
)

// triggerWorkflowForJob triggers a workflow run for a scheduled workflow job,
// then updates the scheduled run record when the workflow completes.
func (s *JobScheduler) triggerWorkflowForJob(runID int64, job store.ScheduledJob, trigger string) {
	ctx := s.parentCtx
	if ctx == nil {
		ctx = context.Background()
	}

	s.runningMu.Lock()
	runCtx, cancel := context.WithCancel(ctx)
	s.running[runID] = cancel
	s.runningMu.Unlock()

	defer func() {
		s.runningMu.Lock()
		delete(s.running, runID)
		s.runningMu.Unlock()
		cancel()
	}()

	// Look up the workflow
	if s.workflowRunner == nil || s.workflowStore == nil {
		s.logger.Error("workflow runner not configured", "job", job.Name)
		s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
			"status": "failed", "error_msg": "workflow runner not configured",
			"finished_at": time.Now().UTC().Format(store.ISOFormat),
		})
		return
	}

	wf, err := s.workflowStore.GetWorkflow(ctx, *job.WorkflowID)
	if err != nil || wf == nil {
		s.logger.Error("workflow not found", "workflow_id", *job.WorkflowID, "error", err)
		s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
			"status": "failed", "error_msg": "workflow not found",
			"finished_at": time.Now().UTC().Format(store.ISOFormat),
		})
		return
	}

	// Mark scheduled run as running
	s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
		"status": "running", "started_at": time.Now().UTC().Format(store.ISOFormat),
	})

	// Trigger the workflow
	triggerCtx := fmt.Sprintf(`{"scheduled_job_id":%d,"scheduled_run_id":%d}`, job.ID, runID)
	wfRun, err := s.workflowRunner.TriggerWorkflow(runCtx, wf, workflowTrigger(trigger), &triggerCtx)
	if err != nil {
		s.logger.Error("failed to trigger workflow", "job", job.Name, "error", err)
		s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
			"status": "failed", "error_msg": err.Error(),
			"finished_at": time.Now().UTC().Format(store.ISOFormat),
		})
		return
	}

	// Poll for workflow run completion
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-runCtx.Done():
			s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
				"status": "failed", "error_msg": "cancelled",
				"finished_at": time.Now().UTC().Format(store.ISOFormat),
			})
			return
		case <-ticker.C:
			run, err := s.workflowRunner.store.GetWorkflowRunDirect(context.Background(), wfRun.ID)
			if err != nil {
				continue
			}
			if run == nil {
				continue
			}
			switch run.Status {
			case "completed":
				s.store.UpdateScheduledRun(ctx, runID, map[string]interface{}{
					"status":      "completed",
					"finished_at": time.Now().UTC().Format(store.ISOFormat),
				})
				return
			case "failed", "killed":
				errMsg := "workflow " + run.Status
				if run.ErrorMsg != nil {
					errMsg = *run.ErrorMsg
				}
				fields := map[string]interface{}{
					"status": run.Status, "error_msg": errMsg,
					"finished_at": time.Now().UTC().Format(store.ISOFormat),
				}
				if run.ErrorCode != nil { // the workflow run's fixed code and CLI (#5469) are the scheduled run's too
					fields["error_code"] = *run.ErrorCode
				}
				if run.AgentType != nil {
					fields["agent_type"] = *run.AgentType
				}
				s.store.UpdateScheduledRun(ctx, runID, fields)
				return
			}
			// Still pending/running — continue polling
		}
	}
}

// workflowTrigger is the trigger a job's workflow run is recorded with: "manual" for Run now, "scheduled" for the schedule's own.
func workflowTrigger(runTrigger string) string {
	if runTrigger == store.TriggerManual {
		return "manual"
	}
	return "scheduled"
}
