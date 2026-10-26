package coordination

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// DefaultInactivityLimit is the heuristic threshold for long active tasks.
const DefaultInactivityLimit = 15 * time.Minute

// Analyze processes tasks, messages, and board status into a structured report.
func Analyze(tasks []Task, messages []Message, status *BoardStatus, filter ReportFilter, now time.Time) Report {
	if now.IsZero() {
		now = time.Now()
	}
	inactivityLimit := filter.InactivityLimit
	if inactivityLimit <= 0 {
		inactivityLimit = DefaultInactivityLimit
	}

	filteredTasks := filterTasks(tasks, filter.Since, filter.Until)
	filteredMessages := filterMessages(messages, filter.Since, filter.Until)

	metadata := ReportMetadata{
		Board:                 filter.Board,
		GeneratedAt:           now,
		WindowStart:           filter.Since,
		WindowEnd:             filter.Until,
		TotalTasksInWindow:    len(filteredTasks),
		TotalMessagesInWindow: len(filteredMessages),
	}
	if status != nil {
		metadata.SubscribersTracked = len(status.Agents)
	}

	taskCounts := countTasks(filteredTasks)
	durations := computeDurations(filteredTasks, tasks)
	activeLoad := computeActiveLoad(filteredTasks, tasks, status, filter.Since)
	depMetrics := computeDependencies(filteredTasks)
	reviewSlots := computeReviewHeldSlots(filteredTasks, now)

	facts := ObservableFacts{
		TaskCounts:          taskCounts,
		Durations:           durations,
		ActiveVsPlannedLoad: activeLoad,
		DependencyGraph:     depMetrics,
		ReviewHeldSlots:     reviewSlots,
	}

	heuristics := HeuristicSignals{
		ReadyUnclaimed:           analyzeReadyUnclaimed(filteredTasks, activeLoad, now),
		ActiveWithoutProgress:    detectActiveWithoutProgress(filteredTasks, filteredMessages, inactivityLimit, now),
		NotificationChurn:        detectNotificationChurn(filteredMessages, filteredTasks),
		ManualRecoveryEvents:     detectManualRecovery(filteredTasks, filteredMessages),
		DuplicateScopeCandidates: detectDuplicateScopeCandidates(filteredTasks),
		RepetitiveHandoffLoops:   detectRepetitiveHandoffs(filteredMessages),
	}

	unavailable := []string{
		"Subagent internal execution duration and step count (only claimed task boundaries recorded)",
		"Agent local CPU, memory, and compiler activity during silent in-progress periods",
		"Exact reasoning activity for uninstrumented external providers",
		"Unrecorded terminal/session crashes that did not trigger coral hook events",
		"Granular file edit timestamps prior to task completion or commit landing",
	}

	scorecard := computeScorecard(taskCounts, durations, heuristics, depMetrics, len(filteredMessages))

	findings := generateKeyFindings(facts, heuristics)
	recommendations := generateRecommendations(facts, heuristics, scorecard)

	return Report{
		Metadata:           metadata,
		ObservableFacts:    facts,
		HeuristicSignals:   heuristics,
		UnavailableMetrics: unavailable,
		CoordinationScore:  scorecard,
		KeyFindings:        findings,
		Recommendations:    recommendations,
	}
}

// computeScorecard implements a transparent, balanced 100-point Coordination Quality Index.
func computeScorecard(counts TaskCounts, times TimingMetrics, h HeuristicSignals, d DependencyMetrics, messageCount int) CoordinationScorecard {
	// Component 1: Claim Promptness (0-25)
	// Measures prompt pickup when owner is idle, without penalizing legitimate busy-owner queueing
	promptness := 25.0
	if h.ReadyUnclaimed.OwnerIdleCount > 0 {
		deduction := float64(h.ReadyUnclaimed.OwnerIdleCount) * 4.0
		if deduction > 20.0 {
			deduction = 20.0
		}
		promptness -= deduction
	}
	if promptness < 0 {
		promptness = 0
	}

	// Component 2: Slot Fluidity (0-25)
	// Measures absence of stalled in-progress tasks
	fluidity := 25.0
	stalledCount := len(h.ActiveWithoutProgress)
	if stalledCount > 0 {
		deduction := float64(stalledCount) * 5.0
		if deduction > 20.0 {
			deduction = 20.0
		}
		fluidity -= deduction
	}
	if fluidity < 0 {
		fluidity = 0
	}

	// Component 3: Dependency Clarity (0-20)
	// Proportion of tasks that have clean dependency resolution
	depClarity := 20.0
	if counts.TotalCreated > 0 && d.TotalBlockedTasks > 0 {
		ratio := float64(d.TotalBlockedTasks) / float64(counts.TotalCreated)
		if ratio > 0.5 {
			depClarity -= 10.0
		} else if ratio > 0.25 {
			depClarity -= 5.0
		}
	}

	// Component 4: Notification Cleanliness (0-15)
	// Absence of redundant nudges and churn
	notifScore := 15.0
	if len(h.NotificationChurn) > 0 {
		deduction := float64(len(h.NotificationChurn)) * 3.0
		if deduction > 12.0 {
			deduction = 12.0
		}
		notifScore -= deduction
	}
	if notifScore < 0 {
		notifScore = 0
	}

	// Component 5: Recovery Economy (0-15)
	// Absence of heavy cancellation or retry rework
	recoveryScore := 15.0
	if len(h.ManualRecoveryEvents) > 0 {
		deduction := float64(len(h.ManualRecoveryEvents)) * 2.5
		if deduction > 10.0 {
			deduction = 10.0
		}
		recoveryScore -= deduction
	}
	if recoveryScore < 0 {
		recoveryScore = 0
	}

	// A dimension is scored only when its required evidence exists. Missing
	// dimensions must not silently become clean/full credit.
	available := 0.0
	observed := 0.0
	if counts.TotalCreated > 0 {
		available += 25 + 25 + 20 + 15
		observed += promptness + fluidity + depClarity + recoveryScore
	} else {
		promptness, fluidity, depClarity, recoveryScore = 0, 0, 0, 0
	}
	if messageCount > 0 {
		available += 15
		observed += notifScore
	} else {
		notifScore = 0
	}
	// A normalized aggregate is only meaningful when every dimension has
	// evidence. Partial samples retain raw observed points but suppress the
	// overall quality number so it cannot be mistaken for board-wide health.
	coverageRatio := math.Round((available/100.0)*1000) / 1000
	suppressed := available < 100
	reportedTotal := observed
	var suppressionRationale string
	if suppressed {
		reportedTotal = 0
		var missing []string
		if counts.TotalCreated == 0 {
			missing = append(missing, "task lifecycle events (Claim Promptness, Slot Fluidity, Dependency Clarity, Recovery Economy)")
		}
		if messageCount == 0 {
			missing = append(missing, "board message stream (Notification Hygiene)")
		}
		if len(missing) == 0 {
			missing = append(missing, "unobserved score dimensions")
		}
		suppressionRationale = fmt.Sprintf("Aggregate score suppressed: sample covers %.1f%% of scorecard dimensions (missing %s). Normalizing partial dimensions or awarding unobserved credit would misrepresent overall coordination quality.", coverageRatio*100, strings.Join(missing, "; "))
	}

	validationStatus := "Provisional / Pending Audit"
	if suppressed {
		if available == 0 {
			validationStatus = "Suppressed / Insufficient evidence"
		} else {
			validationStatus = "Suppressed / Incomplete evidence"
		}
	}

	return CoordinationScorecard{
		TotalScore:             math.Round(reportedTotal*10) / 10,
		ObservedPoints:         math.Round(observed*10) / 10,
		AvailablePoints:        math.Round(available*10) / 10,
		CoverageRatio:          coverageRatio,
		ScoreSuppressed:        suppressed,
		SuppressionRationale:   suppressionRationale,
		ClaimPromptnessScore:   math.Round(promptness*10) / 10,
		SlotFluidityScore:      math.Round(fluidity*10) / 10,
		DependencyClarityScore: math.Round(depClarity*10) / 10,
		NotificationCleanScore: math.Round(notifScore*10) / 10,
		RecoveryEconomyScore:   math.Round(recoveryScore*10) / 10,
		ValidationStatus:       validationStatus,
		AuditCaveat:            fmt.Sprintf("Score reflects observed board events only: %.1f of 100 points are available from this sample (coverage: %.1f%%). Missing dimensions are excluded rather than awarded full credit; local CPU/build runs, agent reasoning, and subagent steps remain unmeasured.", available, coverageRatio*100),
		ScoringMethodology:     "Balanced 100-pt index: Claim Promptness (25), Slot Fluidity (25), Dependency Clarity (20), Notification Signal-to-Noise (15), Recovery Economy (15). Safeguards: serialized planned work is not penalized; cancellation is not scored as success; notification suppression is not rewarded.",
	}
}

func generateKeyFindings(f ObservableFacts, h HeuristicSignals) []string {
	var findings []string

	findings = append(findings, fmt.Sprintf("Total tasks in window: %d (Completed: %d, In Progress: %d, Pending: %d, Blocked: %d, Cancelled: %d)",
		f.TaskCounts.TotalCreated, f.TaskCounts.Completed, f.TaskCounts.InProgress, f.TaskCounts.Pending, f.TaskCounts.Blocked, f.TaskCounts.Cancelled))

	if f.Durations.ReadyToClaimLatency.Count > 0 {
		findings = append(findings, fmt.Sprintf("Median claim latency: %.1fs (P90: %.1fs, Mean: %.1fs across %d claims)",
			f.Durations.ReadyToClaimLatency.MedSec, f.Durations.ReadyToClaimLatency.P90Sec, f.Durations.ReadyToClaimLatency.MeanSec, f.Durations.ReadyToClaimLatency.Count))
	}
	if f.Durations.ExecutionDuration.Count > 0 {
		findings = append(findings, fmt.Sprintf("Median execution duration: %.1fs (P90: %.1fs across %d completed tasks)",
			f.Durations.ExecutionDuration.MedSec, f.Durations.ExecutionDuration.P90Sec, f.Durations.ExecutionDuration.Count))
	}

	if h.ReadyUnclaimed.OwnerBusyCount > 0 {
		findings = append(findings, fmt.Sprintf("Observable planned serialization: %d ready task(s) are queued behind currently active subscriber work (legitimate backlog, NOT coordination lag).",
			h.ReadyUnclaimed.OwnerBusyCount))
	}
	if h.ReadyUnclaimed.OwnerIdleCount > 0 {
		findings = append(findings, fmt.Sprintf("Coordination lag candidate: %d ready task(s) assigned to currently idle subscribers remain unclaimed.",
			h.ReadyUnclaimed.OwnerIdleCount))
	}

	if len(h.NotificationChurn) > 0 {
		findings = append(findings, fmt.Sprintf("Notification churn observed in %d incident(s): reminders dispatched for tasks already claimed or in rapid (<2m) succession.",
			len(h.NotificationChurn)))
	}
	if len(h.ActiveWithoutProgress) > 0 {
		findings = append(findings, fmt.Sprintf("Active duration observation: %d task(s) in progress exceed threshold (candidate status, not proof of inactivity).",
			len(h.ActiveWithoutProgress)))
	}
	if len(h.DuplicateScopeCandidates) > 0 {
		findings = append(findings, fmt.Sprintf("Duplicate scope candidates: %d pair(s) of concurrently created tasks share >70%% title token similarity.",
			len(h.DuplicateScopeCandidates)))
	}

	return findings
}

func generateRecommendations(f ObservableFacts, h HeuristicSignals, s CoordinationScorecard) []string {
	var recs []string

	if h.ReadyUnclaimed.OwnerIdleCount > 0 {
		recs = append(recs, fmt.Sprintf("Dispatch targeted nudges with explicit claim IDs (coral-board task claim <ID>) for the %d unclaimed task(s) assigned to idle subscribers.",
			h.ReadyUnclaimed.OwnerIdleCount))
	}
	if len(h.NotificationChurn) > 0 {
		recs = append(recs, "Debounce orchestrator reminders against actual task claim state to avoid alerting on already-claimed tasks.")
	}
	if f.TaskCounts.Blocked > 0 {
		recs = append(recs, "Monitor upstream prerequisites for blocked tasks to ensure prompt unblocking upon prerequisite completion.")
	}
	if len(h.DuplicateScopeCandidates) > 0 {
		recs = append(recs, "Review overlapping task titles before launch to clarify task boundaries and prevent duplicated agent work.")
	}
	if len(recs) == 0 {
		recs = append(recs, "Queue coordination is operating smoothly with balanced slot utilization and low notification churn.")
	}
	return recs
}

// Helpers
func parseTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, fmt.Errorf("empty time string")
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05Z",
		"2006-01-02 15:04:05",
	}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("could not parse time: %s", s)
}
