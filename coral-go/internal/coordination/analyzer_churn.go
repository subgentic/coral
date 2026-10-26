package coordination

import (
	"fmt"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/ptr"
)

func detectNotificationChurn(messages []Message, tasks []Task) []NotificationChurnIncident {
	var incidents []NotificationChurnIncident

	// Task metadata and claim timestamps
	taskMap := make(map[int64]Task)
	taskClaimMap := make(map[int64]time.Time)
	for _, t := range tasks {
		taskMap[t.ID] = t
		if t.ClaimedAt != nil && *t.ClaimedAt != "" {
			if parsed, err := parseTime(*t.ClaimedAt); err == nil {
				taskClaimMap[t.ID] = parsed
			}
		}
	}

	staleHandled := make(map[int64]bool)

	// Phase 1: Check for stale unclaimed reminders
	// (Message states task is unclaimed, but task was already claimed earlier)
	for _, m := range messages {
		lower := strings.ToLower(m.Content)
		if strings.Contains(lower, "still unclaimed") || strings.Contains(lower, "is unclaimed") || strings.Contains(lower, "unclaimed and blocks") {
			mTime, err := parseTime(m.CreatedAt)
			if err != nil {
				continue
			}
			taskIDs := extractTaskIDs(m.Content)
			for _, id := range taskIDs {
				claimedAt, claimed := taskClaimMap[id]
				if claimed && mTime.After(claimedAt.Add(2*time.Second)) {
					lagSec := mTime.Sub(claimedAt).Seconds()
					task := taskMap[id]
					assignee := ptr.Value(task.AssignedTo)
					if assignee == "" {
						assignee = m.SubscriberID
					}
					incidents = append(incidents, NotificationChurnIncident{
						TaskID:                 id,
						Assignee:               assignee,
						NoticeCount:            1,
						TimeSpanSec:            lagSec,
						StaleInformationAgeSec: lagSec,
						FirstNoticeAt:          claimedAt,
						LastNoticeAt:           mTime,
						ChurnType:              "stale_unclaimed_reminder",
						SampleMessage:          m.Content,
						Sender:                 m.SubscriberID,
						ClaimedAt:              &claimedAt,
						Confidence:             fmt.Sprintf("High (message at %s dispatched %.0fs after claim at %s)", m.CreatedAt, lagSec, claimedAt.Format(time.RFC3339)),
						AnalysisNote:           fmt.Sprintf("Sender %s posted unclaimed reminder for Task #%d at %s (stale-information age: %.0fs after claim by %s at %s). Stale context or delayed dispatch, not measured network transport lag.", m.SubscriberID, id, m.CreatedAt, lagSec, assignee, claimedAt.Format(time.RFC3339)),
					})
					staleHandled[id] = true
				}
			}
		}
	}

	// Phase 2: Group reminder/nudge notices by task ID to detect rapid nudging or repetition
	taskNotices := make(map[int64][]Message)
	for _, m := range messages {
		lower := strings.ToLower(m.Content)
		// Ignore normal task lifecycle announcements and completion handoffs
		if strings.Contains(lower, "completed") || strings.Contains(lower, "complete.") || strings.Contains(lower, "outcome:") || strings.Contains(lower, "unblocked") || strings.Contains(lower, "claimed by") || strings.Contains(lower, "landed") {
			continue
		}
		// Consider messages that are reminders, nudges, or status requests
		if strings.Contains(lower, "nudge") || strings.Contains(lower, "reminder") || strings.Contains(lower, "please") || strings.Contains(lower, "still") || strings.Contains(lower, "waiting") || strings.Contains(lower, "blocking") {
			ids := extractTaskIDs(m.Content)
			for _, id := range ids {
				taskNotices[id] = append(taskNotices[id], m)
			}
		}
	}

	for id, msgs := range taskNotices {
		if staleHandled[id] {
			continue // Already captured with deeper detail above
		}
		if len(msgs) < 2 {
			continue
		}
		first, err1 := parseTime(msgs[0].CreatedAt)
		last, err2 := parseTime(msgs[len(msgs)-1].CreatedAt)
		if err1 != nil || err2 != nil {
			continue
		}
		spanSec := last.Sub(first).Seconds()

		churnType := ""
		if len(msgs) >= 3 && spanSec < 180 {
			churnType = "rapid_nudging"
		} else if len(msgs) >= 2 && spanSec < 90 {
			churnType = "repeated_notices"
		}

		if churnType != "" {
			task := taskMap[id]
			assignee := ptr.Value(task.AssignedTo)
			var claimedAtPtr *time.Time
			if cl, ok := taskClaimMap[id]; ok {
				claimedAtPtr = &cl
			}
			incidents = append(incidents, NotificationChurnIncident{
				TaskID:        id,
				Assignee:      assignee,
				NoticeCount:   len(msgs),
				TimeSpanSec:   spanSec,
				FirstNoticeAt: first,
				LastNoticeAt:  last,
				ChurnType:     churnType,
				SampleMessage: msgs[len(msgs)-1].Content,
				Sender:        msgs[len(msgs)-1].SubscriberID,
				ClaimedAt:     claimedAtPtr,
				Confidence:    "Medium (based on frequency and timespan heuristic)",
				AnalysisNote:  fmt.Sprintf("%d messages referenced Task #%d within %.0fs.", len(msgs), id, spanSec),
			})
		}
	}

	return incidents
}

func extractTaskIDs(content string) []int64 {
	var ids []int64
	seen := make(map[int64]bool)

	// Pattern 1: #\d+
	for i := 0; i < len(content); i++ {
		if content[i] == '#' && i+1 < len(content) && content[i+1] >= '0' && content[i+1] <= '9' {
			var id int64
			j := i + 1
			for j < len(content) && content[j] >= '0' && content[j] <= '9' {
				id = id*10 + int64(content[j]-'0')
				j++
			}
			if id > 0 && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
			i = j - 1
		}
	}

	// Pattern 2: task claim \d+ or task \d+
	lower := strings.ToLower(content)
	patterns := []string{"task claim ", "task #", "task "}
	for _, p := range patterns {
		idx := 0
		for {
			pos := strings.Index(lower[idx:], p)
			if pos == -1 {
				break
			}
			start := idx + pos + len(p)
			var id int64
			j := start
			for j < len(lower) && lower[j] >= '0' && lower[j] <= '9' {
				id = id*10 + int64(lower[j]-'0')
				j++
			}
			if id > 0 && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
			idx = j
		}
	}

	return ids
}
