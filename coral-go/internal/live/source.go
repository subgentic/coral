package live

import (
	"context"
	"sort"
	"time"
)

// LiveSource is where the builder's facts come from. It is an interface so the store behind it can change (the long-term central-state note): a later slice
// wires it to this computer's sessions and board. It returns every agent of the team, sleeping and archived too, so each real name is known to the name rule.
type LiveSource interface {
	Agents(ctx context.Context) ([]AgentRow, error)
	// Posts returns at most the newest n public posts of THIS team's board, oldest first. Gather puts them in order by time as well, so a source that gets it wrong cannot reorder what is shown.
	Posts(ctx context.Context, n int) ([]PostRow, error)
}

// AgentRow is what a source says about one agent: named fields, not a session row. Key identifies the agent for the owner's choice and for nothing else; it is
// never put in a frame.
type AgentRow struct {
	Key                                  string
	Name, Role                           string
	TaskTitle                            string
	Working, Waiting, Sleeping, Archived bool
}

// PostRow is one board post as a source has it.
type PostRow struct {
	Author, Text string
	At           time.Time
}

// ViewChoice is the owner's choice at this computer: which agents are shown. An agent not in it, a new one included, is hidden. A row with no Key is never shown, whatever the map holds.
type ViewChoice struct{ Shown map[string]bool }

// StatusFrom maps stored flags to the four words. Asleep (sleeping or archived) wins over everything, then waiting, then working.
func StatusFrom(a AgentRow) Status {
	switch {
	case a.Sleeping || a.Archived:
		return StatusAsleep
	case a.Waiting:
		return StatusWaiting
	case a.Working:
		return StatusWorking
	}
	return StatusIdle
}

// Gather reads the source into the builder's input.
func Gather(ctx context.Context, src LiveSource, c ViewChoice) (Input, error) {
	rows, err := src.Agents(ctx)
	if err != nil {
		return Input{}, err
	}
	posts, err := src.Posts(ctx, maxPosts)
	if err != nil {
		return Input{}, err
	}
	var in Input
	for _, r := range rows {
		in.Agents = append(in.Agents, AgentFacts{RealName: r.Name, Role: r.Role, Status: StatusFrom(r), TaskTitle: r.TaskTitle, Shown: r.Key != "" && c.Shown[r.Key]})
	}
	sort.SliceStable(posts, func(i, j int) bool { return posts[i].At.Before(posts[j].At) })
	for _, p := range posts {
		in.Posts = append(in.Posts, PostFacts{Author: p.Author, Text: p.Text, At: p.At})
	}
	return in, nil
}
