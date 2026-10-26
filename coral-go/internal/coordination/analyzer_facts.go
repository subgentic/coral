package coordination

import (
	"math"
	"sort"
	"time"

	"github.com/subgentic/coral/internal/ptr"
)

func filterTasks(tasks []Task, since, until *time.Time) []Task {
	var result []Task
	for _, t := range tasks {
		created, err := parseTime(t.CreatedAt)
		if err != nil {
			result = append(result, t)
			continue
		}
		if since != nil && created.Before(*since) {
			continue
		}
		if until != nil && created.After(*until) {
			continue
		}
		result = append(result, t)
	}
	return result
}

func filterMessages(messages []Message, since, until *time.Time) []Message {
	var result []Message
	for _, m := range messages {
		created, err := parseTime(m.CreatedAt)
		if err != nil {
			result = append(result, m)
			continue
		}
		if since != nil && created.Before(*since) {
			continue
		}
		if until != nil && created.After(*until) {
			continue
		}
		result = append(result, m)
	}
	return result
}

func countTasks(tasks []Task) TaskCounts {
	var c TaskCounts
	c.TotalCreated = len(tasks)
	for _, t := range tasks {
		switch t.Status {
		case "completed":
			c.Completed++
		case "in_progress":
			c.InProgress++
		case "pending":
			c.Pending++
		case "blocked":
			c.Blocked++
		case "cancelled":
			c.Cancelled++
		case "skipped":
			c.Skipped++
		}
	}
	return c
}

func computeDurations(cohortTasks []Task, allTasks []Task) TimingMetrics {
	var readyToClaimLats []float64
	var preClaimWaits []float64
	var execDurs []float64
	var leadTimes []float64
	missingCount := 0

	// Build map of completed_at for all tasks
	taskCompMap := make(map[int64]time.Time)
	for _, at := range allTasks {
		if at.CompletedAt != nil && *at.CompletedAt != "" {
			if parsed, err := parseTime(*at.CompletedAt); err == nil {
				taskCompMap[at.ID] = parsed
			}
		}
	}

	for _, t := range cohortTasks {
		cAt, cErr := parseTime(t.CreatedAt)
		if cErr != nil {
			missingCount++
			continue
		}
		var clAt *time.Time
		if t.ClaimedAt != nil && *t.ClaimedAt != "" {
			if parsed, err := parseTime(*t.ClaimedAt); err == nil {
				clAt = &parsed
				waitSec := parsed.Sub(cAt).Seconds()
				preClaimWaits = append(preClaimWaits, waitSec)

				// Determine ready timestamp
				readyAt := cAt
				hasUnmetPrereq := false
				var latestPrereq time.Time
				for _, dep := range t.BlockedBy {
					if comp, ok := taskCompMap[dep.TaskID]; ok {
						if comp.After(latestPrereq) {
							latestPrereq = comp
						}
					} else {
						hasUnmetPrereq = true
					}
				}
				if len(t.BlockedBy) > 0 && !hasUnmetPrereq && !latestPrereq.IsZero() {
					readyAt = latestPrereq
				}
				readyLat := parsed.Sub(readyAt).Seconds()
				if readyLat < 0 {
					readyLat = 0
				}
				readyToClaimLats = append(readyToClaimLats, readyLat)
			} else {
				missingCount++
			}
		} else if t.Status == "completed" || t.Status == "in_progress" {
			missingCount++
		}

		if t.CompletedAt != nil && *t.CompletedAt != "" {
			if compAt, err := parseTime(*t.CompletedAt); err == nil {
				leadTimes = append(leadTimes, compAt.Sub(cAt).Seconds())
				if clAt != nil {
					execDurs = append(execDurs, compAt.Sub(*clAt).Seconds())
				}
			} else {
				missingCount++
			}
		} else if t.Status == "completed" {
			missingCount++
		}
	}

	return TimingMetrics{
		ReadyToClaimLatency: calcStats(readyToClaimLats),
		TotalPreClaimWait:   calcStats(preClaimWaits),
		ExecutionDuration:   calcStats(execDurs),
		TotalLeadTime:       calcStats(leadTimes),
		MissingTimestamps:   missingCount,
	}
}

func calcStats(values []float64) DurationStats {
	if len(values) == 0 {
		return DurationStats{}
	}
	sorted := make([]float64, len(values))
	copy(sorted, values)
	sort.Float64s(sorted)

	sum := 0.0
	minVal := sorted[0]
	maxVal := sorted[len(sorted)-1]
	for _, v := range sorted {
		sum += v
	}
	mean := sum / float64(len(sorted))

	median := sorted[len(sorted)/2]
	if len(sorted)%2 == 0 && len(sorted) > 1 {
		median = (sorted[len(sorted)/2-1] + sorted[len(sorted)/2]) / 2
	}

	p90Idx := int(math.Ceil(0.90*float64(len(sorted)))) - 1
	if p90Idx < 0 {
		p90Idx = 0
	}
	if p90Idx >= len(sorted) {
		p90Idx = len(sorted) - 1
	}
	p90 := sorted[p90Idx]

	return DurationStats{
		Count:   len(sorted),
		MinSec:  minVal,
		MaxSec:  maxVal,
		MeanSec: mean,
		MedSec:  median,
		P90Sec:  p90,
	}
}

func computeActiveLoad(cohortTasks []Task, allTasks []Task, status *BoardStatus, since *time.Time) ActiveLoadMetrics {
	var metrics ActiveLoadMetrics
	assignedMap := make(map[string]int)
	activeTaskBySubscriber := make(map[string]int64)

	// Cohort counts (window-specific)
	for _, t := range cohortTasks {
		switch t.Status {
		case "in_progress":
			metrics.ActiveInProgressTasks++
		case "pending":
			if t.AssignedTo != nil && *t.AssignedTo != "" {
				metrics.PlannedAssignedTasks++
			} else {
				metrics.UnassignedPendingTasks++
			}
		}
	}

	// Board-wide open tasks & carryover detection
	for _, t := range allTasks {
		switch t.Status {
		case "in_progress":
			metrics.BoardWideActiveTasks++
			if t.AssignedTo != nil && *t.AssignedTo != "" {
				activeTaskBySubscriber[*t.AssignedTo] = t.ID
			}
		case "pending", "blocked":
			metrics.BoardWidePendingTasks++
			if t.AssignedTo != nil && *t.AssignedTo != "" {
				assignedMap[*t.AssignedTo]++
			}
		}

		// Detect older carryover tasks created before window start that remain open
		if since != nil && (t.Status == "in_progress" || t.Status == "pending" || t.Status == "blocked") {
			if created, err := parseTime(t.CreatedAt); err == nil && created.Before(*since) {
				metrics.CarryoverOlderTasks = append(metrics.CarryoverOlderTasks, CarryoverTask{
					ID:        t.ID,
					Title:     t.Title,
					Status:    t.Status,
					Assignee:  ptr.Value(t.AssignedTo),
					CreatedAt: t.CreatedAt,
				})
			}
		}
	}

	seenSubscribers := make(map[string]bool)
	if status != nil {
		for _, a := range status.Agents {
			seenSubscribers[a.SubscriberID] = true
			activeID := activeTaskBySubscriber[a.SubscriberID]
			if activeID == 0 {
				for _, t := range a.Tasks {
					if t.Status == "in_progress" {
						activeID = t.ID
						break
					}
				}
			}
			load := SubscriberLoad{
				SubscriberID: a.SubscriberID,
				Role:         a.Role,
				Availability: a.Availability,
				ActiveTaskID: activeID,
				QueuedCount:  assignedMap[a.SubscriberID],
			}
			metrics.SubscriberLoad = append(metrics.SubscriberLoad, load)
		}
	}

	// Also include any active subscribers from tasks who are not in status.Agents
	extra := make([]string, 0, len(activeTaskBySubscriber))
	for sub := range activeTaskBySubscriber {
		if !seenSubscribers[sub] {
			extra = append(extra, sub)
		}
	}
	sort.Strings(extra) // by id: a map's order differs from call to call, and so would the report
	for _, sub := range extra {
		metrics.SubscriberLoad = append(metrics.SubscriberLoad, SubscriberLoad{
			SubscriberID: sub,
			Role:         sub,
			Availability: "busy",
			ActiveTaskID: activeTaskBySubscriber[sub],
			QueuedCount:  assignedMap[sub],
		})
	}

	return metrics
}

func computeDependencies(tasks []Task) DependencyMetrics {
	var blockedList []BlockedTask
	taskStatusMap := make(map[int64]string)
	for _, t := range tasks {
		taskStatusMap[t.ID] = t.Status
	}

	for _, t := range tasks {
		if t.Status != "blocked" {
			continue
		}
		bTask := BlockedTask{
			TaskID:   t.ID,
			Title:    t.Title,
			Assignee: ptr.Value(t.AssignedTo),
		}
		for _, dep := range t.BlockedBy {
			curStatus := taskStatusMap[dep.TaskID]
			if curStatus == "" {
				curStatus = "unknown/external"
			}
			cond := dep.Condition
			if cond == "" {
				cond = "success"
			}
			satisfied := curStatus == "completed"
			bTask.Dependencies = append(bTask.Dependencies, DependencyStatus{
				PrerequisiteID: dep.TaskID,
				CurrentStatus:  curStatus,
				Condition:      cond,
				Satisfied:      satisfied,
			})
		}
		blockedList = append(blockedList, bTask)
	}

	return DependencyMetrics{
		TotalBlockedTasks: len(blockedList),
		BlockedTasks:      blockedList,
	}
}

func computeReviewHeldSlots(tasks []Task, now time.Time) []ReviewHeldTask {
	var reviewTasks []ReviewHeldTask
	for _, t := range tasks {
		if t.Workflow != nil && t.Workflow.CompletionReview != nil {
			duration := 0.0
			if t.ClaimedAt != nil {
				if cl, err := parseTime(*t.ClaimedAt); err == nil {
					duration = now.Sub(cl).Seconds()
				}
			}
			reviewTasks = append(reviewTasks, ReviewHeldTask{
				TaskID:       t.ID,
				Title:        t.Title,
				Assignee:     ptr.Value(t.AssignedTo),
				ReviewerRole: t.Workflow.CompletionReview.ReviewerRole,
				DurationSec:  duration,
			})
		}
	}
	return reviewTasks
}
