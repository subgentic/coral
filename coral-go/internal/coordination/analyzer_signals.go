package coordination

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/ptr"
)

// analyzeReadyUnclaimed accurately separates owner-busy backlog from owner-idle coordination lag.
func analyzeReadyUnclaimed(tasks []Task, load ActiveLoadMetrics, now time.Time) ReadyUnclaimedAnalysis {
	var analysis ReadyUnclaimedAnalysis

	// Build map of subscribers with active tasks
	busySubscribers := make(map[string]int64)
	for _, sub := range load.SubscriberLoad {
		if sub.ActiveTaskID != 0 || sub.Availability == "busy" {
			busySubscribers[sub.SubscriberID] = sub.ActiveTaskID
		}
	}

	for _, t := range tasks {
		if t.Status != "pending" {
			continue
		}
		createdAt, err := parseTime(t.CreatedAt)
		age := 0.0
		if err == nil {
			age = now.Sub(createdAt).Seconds()
		}

		assignee := ptr.Value(t.AssignedTo)
		if assignee == "" {
			analysis.UnassignedCount++
			analysis.UnassignedTasks = append(analysis.UnassignedTasks, ReadyTaskDetail{
				TaskID:      t.ID,
				Title:       t.Title,
				Priority:    t.Priority,
				Assignee:    "—",
				AgeSeconds:  age,
				OwnerStatus: "unassigned",
			})
			continue
		}

		activeID, busy := busySubscribers[assignee]
		if busy {
			analysis.OwnerBusyCount++
			analysis.OwnerBusyTasks = append(analysis.OwnerBusyTasks, ReadyTaskDetail{
				TaskID:        t.ID,
				Title:         t.Title,
				Priority:      t.Priority,
				Assignee:      assignee,
				AgeSeconds:    age,
				OwnerStatus:   "busy_with_active_task",
				OwnerActiveID: activeID,
			})
		} else {
			analysis.OwnerIdleCount++
			analysis.OwnerIdleTasks = append(analysis.OwnerIdleTasks, ReadyTaskDetail{
				TaskID:      t.ID,
				Title:       t.Title,
				Priority:    t.Priority,
				Assignee:    assignee,
				AgeSeconds:  age,
				OwnerStatus: "idle_available",
			})
		}
	}

	return analysis
}

func detectActiveWithoutProgress(tasks []Task, messages []Message, threshold time.Duration, now time.Time) []ActiveWithoutProgress {
	var candidates []ActiveWithoutProgress

	// Build map of last message time per subscriber
	lastMsgMap := make(map[string]time.Time)
	for _, m := range messages {
		t, err := parseTime(m.CreatedAt)
		if err == nil {
			if prev, ok := lastMsgMap[m.SubscriberID]; !ok || t.After(prev) {
				lastMsgMap[m.SubscriberID] = t
			}
		}
	}

	for _, t := range tasks {
		if t.Status != "in_progress" {
			continue
		}
		if t.ClaimedAt == nil || *t.ClaimedAt == "" {
			continue
		}
		clTime, err := parseTime(*t.ClaimedAt)
		if err != nil {
			continue
		}
		duration := now.Sub(clTime)
		if duration >= threshold {
			assignee := ptr.Value(t.AssignedTo)
			var lastMsg *time.Time
			if lm, ok := lastMsgMap[assignee]; ok {
				lastMsg = &lm
			}
			candidates = append(candidates, ActiveWithoutProgress{
				TaskID:          t.ID,
				Title:           t.Title,
				Assignee:        assignee,
				ClaimedAt:       clTime,
				DurationSeconds: duration.Seconds(),
				LastMessageAt:   lastMsg,
				ConfidenceNote:  "Candidate indicator only. Does not prove inactivity; agent may be running local builds/tests or model reasoning.",
			})
		}
	}
	return candidates
}

func detectManualRecovery(tasks []Task, messages []Message) []ManualRecoveryEvent {
	var events []ManualRecoveryEvent

	for _, t := range tasks {
		if t.Status == "cancelled" {
			ts, _ := parseTime(t.CreatedAt)
			reason := ptr.Value(t.CompletionMessage)
			events = append(events, ManualRecoveryEvent{
				TaskID:    t.ID,
				Title:     t.Title,
				EventType: "cancellation",
				Actor:     ptr.Value(t.CompletedBy),
				Timestamp: ts,
				Reason:    reason,
			})
		}
		if t.Workflow != nil && t.Workflow.RetryOf > 0 {
			ts, _ := parseTime(t.CreatedAt)
			events = append(events, ManualRecoveryEvent{
				TaskID:      t.ID,
				Title:       t.Title,
				EventType:   "retry",
				Actor:       t.CreatedBy,
				Timestamp:   ts,
				Predecessor: t.Workflow.RetryOf,
				Reason:      "Retry of predecessor task",
			})
		}
	}

	for _, m := range messages {
		if strings.Contains(m.Content, "reassigned") {
			ts, _ := parseTime(m.CreatedAt)
			events = append(events, ManualRecoveryEvent{
				Title:     m.Content,
				EventType: "reassignment",
				Actor:     m.SubscriberID,
				Timestamp: ts,
				Reason:    m.Content,
			})
		}
	}

	return events
}

func detectDuplicateScopeCandidates(tasks []Task) []DuplicateScopeCandidate {
	var duplicates []DuplicateScopeCandidate
	stopWords := map[string]bool{"the": true, "and": true, "for": true, "to": true, "in": true, "a": true, "of": true, "on": true, "with": true, "is": true}

	for i := 0; i < len(tasks); i++ {
		t1 := tasks[i]
		time1, err1 := parseTime(t1.CreatedAt)
		words1 := tokenize(t1.Title, stopWords)
		if len(words1) == 0 {
			continue
		}

		for j := i + 1; j < len(tasks); j++ {
			t2 := tasks[j]
			time2, err2 := parseTime(t2.CreatedAt)
			words2 := tokenize(t2.Title, stopWords)
			if len(words2) == 0 {
				continue
			}

			// Temporal proximity: within 6 hours
			if err1 == nil && err2 == nil {
				diff := time1.Sub(time2)
				if diff < 0 {
					diff = -diff
				}
				if diff > 6*time.Hour {
					continue
				}
			}

			sim, shared := jaccardSimilarity(words1, words2)
			overlap := 0.0
			minLen := len(words1)
			if len(words2) < minLen {
				minLen = len(words2)
			}
			if minLen > 0 {
				overlap = float64(len(shared)) / float64(minLen)
			}
			if sim >= 0.50 || (overlap >= 0.70 && len(shared) >= 3) {
				score := sim
				if overlap > score {
					score = overlap
				}
				duplicates = append(duplicates, DuplicateScopeCandidate{
					TaskID1:     t1.ID,
					Title1:      t1.Title,
					TaskID2:     t2.ID,
					Title2:      t2.Title,
					Similarity:  math.Round(score*100) / 100,
					CreatedAt1:  time1,
					CreatedAt2:  time2,
					SharedWords: shared,
				})
			}
		}
	}
	return duplicates
}

func detectRepetitiveHandoffs(messages []Message) []RepetitiveHandoffLoop {
	var loops []RepetitiveHandoffLoop
	if len(messages) < 4 {
		return loops
	}

	// Detect if consecutive messages rapidly ping-pong between same actors
	windowSize := 6
	for i := 0; i+windowSize <= len(messages); i++ {
		window := messages[i : i+windowSize]
		counts := make(map[string]int)
		for _, m := range window {
			counts[m.SubscriberID]++
		}
		if len(counts) == 2 {
			tFirst, _ := parseTime(window[0].CreatedAt)
			tLast, _ := parseTime(window[windowSize-1].CreatedAt)
			span := tLast.Sub(tFirst).Seconds()
			if span < 120 {
				var agents []string
				for a := range counts {
					agents = append(agents, a)
				}
				sort.Strings(agents) // the agents and the summary naming them are the same on every call
				loops = append(loops, RepetitiveHandoffLoop{
					Agents:       agents,
					MessageCount: windowSize,
					TimeSpanSec:  span,
					Summary:      fmt.Sprintf("Rapid %d-message back-and-forth between %s within %.0fs", windowSize, strings.Join(agents, " & "), span),
					FirstTime:    tFirst,
					LastTime:     tLast,
				})
				i += windowSize - 1 // skip ahead
			}
		}
	}
	return loops
}

func tokenize(s string, stopWords map[string]bool) []string {
	lower := strings.ToLower(s)
	fields := strings.FieldsFunc(lower, func(r rune) bool {
		return r < 'a' || r > 'z'
	})
	var result []string
	for _, f := range fields {
		if len(f) > 2 && !stopWords[f] {
			result = append(result, f)
		}
	}
	return result
}

func jaccardSimilarity(a, b []string) (float64, []string) {
	setA := make(map[string]bool)
	for _, w := range a {
		setA[w] = true
	}
	setB := make(map[string]bool)
	for _, w := range b {
		setB[w] = true
	}

	intersection := 0
	var shared []string
	for w := range setA {
		if setB[w] {
			intersection++
			shared = append(shared, w)
		}
	}
	sort.Strings(shared) // a map's order differs from call to call
	union := len(setA) + len(setB) - intersection
	if union == 0 {
		return 0, nil
	}
	return float64(intersection) / float64(union), shared
}
