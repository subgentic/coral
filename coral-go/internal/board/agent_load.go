package board

import (
	"context"
	"sort"
	"strings"
)

// AgentLoad is how loaded one agent of a team is, for the assignment limit (#14862): the tasks waiting for it (pending, assigned to it: review tasks included, they are tasks too), whether it is awake and its role.
type AgentLoad struct {
	Name    string `json:"name"`
	Role    string `json:"role,omitempty"`
	Waiting int    `json:"waiting"`
	Awake   bool   `json:"awake"`
}

// AgentLoads lists the team's agents (a member with a session of its own that is still on the board) by load: fewest waiting first, awake before asleep, then by name. It is the answer to "who else could take this".
func (s *Store) AgentLoads(ctx context.Context, project string) ([]AgentLoad, error) {
	subs, err := s.ListSubscribers(ctx, project)
	if err != nil {
		return nil, err
	}
	tasks, err := s.ListTasks(ctx, project)
	if err != nil {
		return nil, err
	}
	asleep, _ := s.SleepingSubscribers(ctx, project)
	auto, _ := s.AutoAsleepSubscribers(ctx, project)
	var out []AgentLoad
	for _, sub := range subs {
		if sub.IsActive == 0 || strings.TrimSpace(sub.SessionName) == "" || strings.EqualFold(sub.SubscriberID, OperatorName) {
			continue
		}
		n := 0
		for _, t := range tasks {
			if t.Status == "pending" && t.AssignedTo != nil && SameIdentity(*t.AssignedTo, sub.SubscriberID) {
				n++
			}
		}
		out = append(out, AgentLoad{Name: sub.SubscriberID, Role: strings.TrimSpace(sub.JobTitle), Waiting: n, Awake: !asleep[sub.SubscriberID] && !auto[sub.SubscriberID]})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Waiting != out[j].Waiting {
			return out[i].Waiting < out[j].Waiting
		}
		if out[i].Awake != out[j].Awake {
			return out[i].Awake
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}
