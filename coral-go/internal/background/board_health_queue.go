package background

import (
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/resourcequeue"
)

// SetResourceQueue gives the check the resource lines (the mac-heavy queue, #13613): an agent in line for a resource that waits on the one ahead of it is in a queue, not waiting on a person (#13707).
func (m *BoardHealthMonitor) SetResourceQueue(q *resourcequeue.Queue) {
	if q == nil {
		m.queue = nil
		return
	}
	m.queue = q.All
}

// inQueueWait says whether w is a wait in a resource line: its waiter is waiting in some line, and the party it waits on holds a slot of that resource or is in that line ahead of the waiter. Such a wait is
// answered by the line moving, so the check does not list it, flag it as slow or tell the party ahead that anyone waits on it ("Frontend Dev has waited 10 min on QA Reviewer 2" when Frontend Dev was
// only behind them in the mac-heavy line). It is still a waiting agent in the counts.
func (m *BoardHealthMonitor) inQueueWait(w board.RegisteredWait, target waitTarget) bool {
	if m.queue == nil || target.sub == nil {
		return false
	}
	for _, st := range m.queue() {
		place := -1
		for i, e := range st.Queue {
			if board.SameIdentity(e.Agent, w.SubscriberID) {
				place = i
			}
		}
		if place < 0 {
			continue
		}
		for _, h := range st.Holders {
			if board.SameIdentity(h.Agent, target.sub.SubscriberID) {
				return true
			}
		}
		for _, e := range st.Queue[:place] {
			if board.SameIdentity(e.Agent, target.sub.SubscriberID) {
				return true
			}
		}
	}
	return false
}
