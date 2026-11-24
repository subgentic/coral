package live

import (
	"context"
	"errors"
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
	Generation                           string // the session's identity for chat (MUST B): session id plus its start; "" means chat is unavailable for this agent. Never in a frame.
	Type                                 string // the CLI (claude, codex, ...): decides whether chat is tested for it. Never in a frame.
	Name, Role                           string
	TaskTitle                            string
	Working, Waiting, Sleeping, Archived bool
}

// PostRow is one board post as a source has it.
type PostRow struct {
	Author, Text string
	At           time.Time
}

// ViewChoice is the owner's choice at this computer: which agents are shown, and the one agent whose chat is shown with the generation the pick was bound to. An agent not in it, a new one included, is
// hidden. A row with no Key is never shown, whatever the map holds.
type ViewChoice struct {
	Shown            map[string]bool
	ChatKey, ChatGen string
}

// ChatRow is one message of the chosen agent's chat as a source has it: From is "person" or "agent".
type ChatRow struct {
	From string
	Text string
	At   time.Time
}

// ChatSource is what a source offers for chat: the newest n messages of the agent with this key, but only while the agent is still the session the pick was bound to (gen). When it is not (a restart, a resume,
// a replacement or a reused name), it returns ErrGenChanged and nothing: an old chat never shows under a new session (MUST B).
type ChatSource interface {
	Chat(ctx context.Context, key, gen string, n int) ([]ChatRow, error)
}

// ErrGenChanged: the agent is not the session the chat pick was bound to.
var ErrGenChanged = errors.New("chat generation changed")

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
		shown := r.Key != "" && !r.Archived && c.Shown[r.Key]
		a := AgentFacts{RealName: r.Name, Role: r.Role, Status: StatusFrom(r), TaskTitle: r.TaskTitle, Shown: shown}
		if shown && c.ChatKey != "" && r.Key == c.ChatKey {
			if cs, ok := src.(ChatSource); ok {
				if rs, err := cs.Chat(ctx, c.ChatKey, c.ChatGen, maxChat); err == nil { // an error or a changed generation is no chat
					a.Chat = rs
				}
			}
		}
		in.Agents = append(in.Agents, a)
	}
	sort.SliceStable(posts, func(i, j int) bool { return posts[i].At.Before(posts[j].At) })
	for _, p := range posts {
		in.Posts = append(in.Posts, PostFacts{Author: p.Author, Text: p.Text, At: p.At})
	}
	return in, nil
}
