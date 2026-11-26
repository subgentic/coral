package background

import (
	"context"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// expireClaims sends back to pending a task in progress whose owner is asleep, gone or idle (not in a turn) and that has shown no activity for the team's claim_expire_hours (#21700): the claim of an agent
// that went away is not a live piece of work. The task stays its owner's, so it is claimed afresh; a task parked or marked waiting on a member or condition (task wait-on) is exempt, as is any task
// whose owner is in a turn. Each one is added to the check once, as it happens, and the set of task ids is returned so the stalled line skips them.
func (m *BoardHealthMonitor) expireClaims(ctx context.Context, in rosterInputs, r *teamhealth.Roster) map[int64]bool {
	expired := map[int64]bool{}
	hours := m.store.GetHealthSettings(ctx, in.project).ClaimExpireHours
	if hours <= 0 {
		return expired
	}
	after := time.Duration(hours) * time.Hour
	waits, _ := m.store.ListTaskWaits(ctx, in.project)
	waiting := map[int64]bool{}
	for _, w := range waits {
		waiting[w.TaskID] = true
	}
	for _, t := range in.tasks {
		if t.Status != "in_progress" || t.AssignedTo == nil || waiting[t.ID] || t.Parked(in.now) {
			continue
		}
		var sub *board.Subscriber
		for i := range in.subs {
			if board.SameIdentity(in.subs[i].SubscriberID, *t.AssignedTo) {
				sub = &in.subs[i]
				break
			}
		}
		last, _ := m.store.TaskLastActivity(ctx, in.project, t.ID)
		if sub != nil {
			if a, live := in.bySession[sub.SessionName]; live {
				sig, known := m.signal(ctx, a.SessionID)
				if known && sig.InTurn {
					continue // working right now
				}
				if known && sig.LastEvent.After(last) {
					last = sig.LastEvent
				}
			}
		}
		if last.IsZero() || in.now.Sub(last) < after {
			continue
		}
		ok, err := m.store.RequeueStaleClaim(ctx, in.project, t.ID, in.now.Add(-after))
		if err != nil || !ok {
			continue
		}
		expired[t.ID] = true
		name := *t.AssignedTo
		if sub != nil {
			name = sub.SubscriberID
		}
		r.Requeued = append(r.Requeued, teamhealth.RequeuedClaim{Agent: teamhealth.Name(name), Task: t.ID, Silent: in.now.Sub(last)})
	}
	return expired
}
