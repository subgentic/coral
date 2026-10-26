package coordination

import (
	"strings"
	"testing"
	"time"
)

// #8422: FormatMarkdown's branches, pinned before the function is split into one function per section. The seeded board's golden (pin_report.md) reaches the common path; these three reports are
// built by hand so that every optional part appears once (the window ends, the score suppressed with and without its rationale, the audit caveat, the carryover and blocked tables, the
// review-held slots, the churn and recovery rows with their defaults and truncation, duplicates, handoff loops) and once absent (every empty section).

func fmtTime(h, m, s int) time.Time { return time.Date(2026, 10, 26, h, m, s, 0, time.UTC) }

func fmtReportFull() Report {
	start, end := fmtTime(8, 0, 0), fmtTime(18, 0, 0)
	return Report{
		Metadata: ReportMetadata{Board: "coral-go-team", GeneratedAt: fmtTime(18, 30, 0), WindowStart: &start, WindowEnd: &end, TotalTasksInWindow: 12, TotalMessagesInWindow: 340, SubscribersTracked: 6},
		ObservableFacts: ObservableFacts{
			TaskCounts: TaskCounts{TotalCreated: 12, Completed: 5, InProgress: 2, Pending: 3, Blocked: 1, Cancelled: 1, Skipped: 0},
			Durations: TimingMetrics{
				ReadyToClaimLatency: DurationStats{Count: 4, MinSec: 1.25, MaxSec: 90, MeanSec: 30.5, MedSec: 20, P90Sec: 80.75},
				TotalPreClaimWait:   DurationStats{Count: 0},
				ExecutionDuration:   DurationStats{Count: 5, MinSec: 60, MaxSec: 3600, MeanSec: 900, MedSec: 600, P90Sec: 3000},
				TotalLeadTime:       DurationStats{Count: 1, MinSec: 7, MaxSec: 7, MeanSec: 7, MedSec: 7, P90Sec: 7},
				MissingTimestamps:   2,
			},
			ActiveVsPlannedLoad: ActiveLoadMetrics{
				ActiveInProgressTasks: 2, PlannedAssignedTasks: 3, UnassignedPendingTasks: 1, BoardWideActiveTasks: 4, BoardWidePendingTasks: 9,
				CarryoverOlderTasks: []CarryoverTask{
					{ID: 8001, Title: "Old task one", Status: "pending", Assignee: "Backend Dev", CreatedAt: "2026-10-20T09:00:00Z"},
					{ID: 8002, Title: "Old task two", Status: "in_progress", Assignee: "", CreatedAt: "2026-10-21T09:00:00Z"},
				},
				SubscriberLoad: []SubscriberLoad{
					{SubscriberID: "Backend Dev", Role: "dev", Availability: "busy", ActiveTaskID: 8422, QueuedCount: 2},
					{SubscriberID: "QA Reviewer", Role: "qa", Availability: "available", ActiveTaskID: 0, QueuedCount: 0},
				},
			},
			DependencyGraph: DependencyMetrics{TotalBlockedTasks: 1, BlockedTasks: []BlockedTask{
				{TaskID: 8403, Title: "Blocked on two", Assignee: "Frontend Dev", Dependencies: []DependencyStatus{
					{PrerequisiteID: 8401, CurrentStatus: "completed", Condition: "completed", Satisfied: true},
					{PrerequisiteID: 8402, CurrentStatus: "in_progress", Condition: "completed", Satisfied: false},
				}},
				{TaskID: 8404, Title: "Blocked on none listed", Assignee: "", Dependencies: nil},
			}},
			ReviewHeldSlots: []ReviewHeldTask{{TaskID: 8387, Title: "Share the rule", Assignee: "Backend Dev", ReviewerRole: "security", DurationSec: 1234.6}},
		},
		HeuristicSignals: HeuristicSignals{
			ReadyUnclaimed: ReadyUnclaimedAnalysis{
				OwnerBusyCount: 2, OwnerBusyTasks: []ReadyTaskDetail{{TaskID: 8410, Title: "Waits", Assignee: "Backend Dev", AgeSeconds: 300.4, OwnerActiveID: 8422}},
				OwnerIdleCount: 1, OwnerIdleTasks: []ReadyTaskDetail{{TaskID: 8411, Title: "Idle owner", Assignee: "QA Reviewer", AgeSeconds: 61}},
				UnassignedCount: 3,
			},
			NotificationChurn: []NotificationChurnIncident{
				{TaskID: 8420, Assignee: "Backend Dev", TimeSpanSec: 120, StaleInformationAgeSec: 0, ChurnType: "rapid_nudging", SampleMessage: "short"},
				{TaskID: 8421, Assignee: "Frontend Dev", TimeSpanSec: 10, StaleInformationAgeSec: 900, ChurnType: "stale_unclaimed_reminder", Sender: "Orchestrator", Confidence: "High", SampleMessage: "line one\nline two that goes on and on and on and on and on and on and on and on and on"},
			},
			ActiveWithoutProgress:    []ActiveWithoutProgress{{TaskID: 8422, Title: "Census", Assignee: "Backend Dev", ClaimedAt: fmtTime(9, 5, 7), DurationSeconds: 7200.2, ConfidenceNote: "no message since the claim"}},
			DuplicateScopeCandidates: []DuplicateScopeCandidate{{TaskID1: 8300, Title1: "Split the file", TaskID2: 8301, Title2: "Split the file again", Similarity: 0.874, SharedWords: []string{"split", "file"}}},
			ManualRecoveryEvents: []ManualRecoveryEvent{
				{TaskID: 8350, EventType: "cancellation", Actor: "Orchestrator", Reason: "superseded"},
				{TaskID: 0, EventType: "reassignment", Actor: "Orchestrator", Reason: strings.Repeat("long reason ", 12)},
			},
			RepetitiveHandoffLoops: []RepetitiveHandoffLoop{{Agents: []string{"Backend Dev", "QA Reviewer"}, MessageCount: 8, TimeSpanSec: 540, FirstTime: fmtTime(10, 0, 0), LastTime: fmtTime(10, 9, 0)}},
		},
		UnavailableMetrics: []string{"Token cost per task", "Agent idle reasons"},
		CoordinationScore: CoordinationScorecard{
			ScoreSuppressed: true, SuppressionRationale: "only 70 of 100 points can be observed", ObservedPoints: 52.5, AvailablePoints: 70, CoverageRatio: 0.7,
			ClaimPromptnessScore: 20.5, SlotFluidityScore: 10, DependencyClarityScore: 12.25, NotificationCleanScore: 5, RecoveryEconomyScore: 4.75,
			ValidationStatus: "Provisional / Pending Audit", AuditCaveat: "the board status was not observed", ScoringMethodology: "Penalties from observed evidence only.",
		},
		KeyFindings:     []string{"Two slots were held in review.", "One owner sat idle."},
		Recommendations: []string{"Nudge the idle owner.", "Review earlier."},
	}
}

// A scored report with the window open at one end, every optional part empty and the defaults of the churn and load rows.
func fmtReportScored() Report {
	start := fmtTime(8, 0, 0)
	return Report{
		Metadata: ReportMetadata{Board: "b", GeneratedAt: fmtTime(9, 0, 0), WindowStart: &start},
		ObservableFacts: ObservableFacts{
			ActiveVsPlannedLoad: ActiveLoadMetrics{SubscriberLoad: []SubscriberLoad{{SubscriberID: "A", Role: "r", Availability: "available", QueuedCount: 1}}},
		},
		CoordinationScore: CoordinationScorecard{TotalScore: 88.25, AvailablePoints: 100, CoverageRatio: 1, ScoringMethodology: "m"},
		KeyFindings:       []string{"fine"},
	}
}

// A suppressed score without its rationale, a window with only its end, and an empty report otherwise.
func fmtReportSuppressedBare() Report {
	end := fmtTime(12, 0, 0)
	return Report{
		Metadata:          ReportMetadata{Board: "empty", GeneratedAt: fmtTime(12, 30, 0), WindowEnd: &end},
		CoordinationScore: CoordinationScorecard{ScoreSuppressed: true, ObservedPoints: 10, CoverageRatio: 0.25, ValidationStatus: "Suppressed / Incomplete Evidence"},
	}
}

func TestFormatMarkdownEveryBranchGolden(t *testing.T) {
	assertGolden(t, "testdata/format_full.md", FormatMarkdown(fmtReportFull()))
	assertGolden(t, "testdata/format_scored.md", FormatMarkdown(fmtReportScored()))
	assertGolden(t, "testdata/format_suppressed_bare.md", FormatMarkdown(fmtReportSuppressedBare()))
}

// #8442: truncate keeps a text of max runes whole and cuts one of max+1 to max-1 runes and an ellipsis; it counts runes, not bytes, and a newline is a space.
func TestTruncateAtTheLimit(t *testing.T) {
	for _, tc := range []struct {
		name, in string
		max      int
		want     string
	}{
		{"shorter", "abc", 5, "abc"},
		{"exactly max runes", "abcde", 5, "abcde"},
		{"max+1 runes", "abcdef", 5, "abcd…"},
		{"exactly max multi-byte runes", "héllo", 5, "héllo"},
		{"max+1 multi-byte runes", "héllo!", 5, "héll…"},
		{"newlines are spaces, counted after", "a\nb\nc", 5, "a b c"},
		{"newlines then over", "a\nb\nc\nd", 5, "a b …"},
		{"empty", "", 5, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := truncate(tc.in, tc.max); got != tc.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", tc.in, tc.max, got, tc.want)
			}
		})
	}
}
