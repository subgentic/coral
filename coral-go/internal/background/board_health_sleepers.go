package background

import (
	"context"
	"fmt"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// A sleeping agent is worth a wake only when something is for it (#11803): a question still open to it, a reply to its own post, or a task assigned to it
// that it has not started. Messages that tag it among others (a broadcast) are counted and earn no wake: an agent the operator put to sleep is not
// woken by the Orchestrator's status posts.
type sleeperTags struct {
	name  string
	tags  board.UnreadTags
	tasks int       // pending tasks assigned to it
	since time.Time // the oldest of what is for it
}

func (s sleeperTags) forIt() bool { return s.tags.Directed > 0 || s.tasks > 0 }

// sleeperTagsOf reads the unread tags of every sleeping member but the recipient.
func (m *BoardHealthMonitor) sleeperTagsOf(ctx context.Context, project string, subs []board.Subscriber, recipient *board.Subscriber, tasks []board.Task) map[string]sleeperTags {
	sleeping, _ := m.store.SleepingSubscribers(ctx, project)
	out := map[string]sleeperTags{}
	for _, sub := range subs {
		if !sleeping[sub.SubscriberID] || (recipient != nil && board.SameIdentity(sub.SubscriberID, recipient.SubscriberID)) {
			continue
		}
		st := sleeperTags{name: teamhealth.Name(sub.SubscriberID)}
		if tags, err := m.store.UnreadTags(ctx, project, sub.SubscriberID); err == nil {
			st.tags, st.since = tags, tags.DirectedSince
		}
		for _, t := range tasks {
			if t.Status != "pending" || t.AssignedTo == nil || !board.SameIdentity(*t.AssignedTo, sub.SubscriberID) {
				continue
			}
			st.tasks++
			if at, err := time.Parse(time.RFC3339, t.CreatedAt); err == nil && (st.since.IsZero() || at.Before(st.since)) {
				st.since = at
			}
		}
		out[sub.SubscriberID] = st
	}
	return out
}

// sleeperItems is one item for each sleeper with something for it, acknowledged like the others (the key is the member; the state is what is waiting, so
// it comes back when something new is).
func sleeperItems(sleepers map[string]sleeperTags, subs []board.Subscriber, now time.Time) []teamhealth.Item {
	var items []teamhealth.Item
	for _, sub := range subs {
		st, ok := sleepers[sub.SubscriberID]
		if !ok || !st.forIt() {
			continue
		}
		problem := "asleep with "
		if st.tags.Directed > 0 {
			problem += fmt.Sprintf("%s for it unread (a question to it or a reply to its post) since %s", teamhealthPlural(st.tags.Directed, "message", "messages"), st.since.UTC().Format("15:04"))
			if st.tasks > 0 {
				problem += " and "
			}
		}
		if st.tasks > 0 {
			problem += teamhealthPlural(st.tasks, "task", "tasks") + " assigned to it not started"
		}
		evidence := ""
		if n := st.tags.Broadcasts(); n > 0 {
			evidence = teamhealthPlural(n, "other tag", "other tags") + " to it are broadcasts"
		}
		items = append(items, teamhealth.Item{Rank: 2, Age: now.Sub(st.since), Agent: st.name, Problem: problem, Evidence: evidence, Suggest: "wake it",
			Key: "asleep|" + sub.SubscriberID, State: fmt.Sprintf("%d|%d", st.tags.Directed, st.tasks)})
	}
	return items
}

func teamhealthPlural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
