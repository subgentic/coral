package coordination

import (
	"fmt"
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
