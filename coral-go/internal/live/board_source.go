package live

import (
	"context"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// AgentState is what is known of an agent's session; the wiring that builds the server fills it from the sessions it keeps.
type AgentState struct{ Working, Waiting, Sleeping, Archived bool }

// BoardReader is the part of the board store the source reads: this team's agents, tasks and messages, all by project.
type BoardReader interface {
	ListAllSubscribers(ctx context.Context, project string) ([]board.Subscriber, error)
	ActiveTaskForSubscriber(ctx context.Context, project, subscriberID string) *board.Task
	ListMessages(ctx context.Context, project string, limit, offset int, beforeID int64) ([]board.Message, error)
}

// BoardSource is the LiveSource over a team's board. It reads ONE project, named at construction, and nothing else: another team's agents and posts are never asked for.
type BoardSource struct {
	r       BoardReader
	project string
	state   func(subscriberID string) AgentState
}

// NewBoardSource makes the source for one team.
func NewBoardSource(r BoardReader, project string, state func(subscriberID string) AgentState) *BoardSource {
	return &BoardSource{r: r, project: project, state: state}
}

// Agents hands over every agent the team has had, the ones that left too, so each name is known to the name rule. A subscription with no id is not handed over.
func (b *BoardSource) Agents(ctx context.Context) ([]AgentRow, error) {
	subs, err := b.r.ListAllSubscribers(ctx, b.project)
	if err != nil {
		return nil, err
	}
	var out []AgentRow
	for _, s := range subs {
		id := strings.TrimSpace(s.SubscriberID)
		if id == "" {
			continue
		}
		st := AgentState{}
		if b.state != nil {
			st = b.state(id)
		}
		if s.IsActive == 0 {
			st.Archived = true
		}
		row := AgentRow{Key: id, Name: id, Role: s.JobTitle, Working: st.Working, Waiting: st.Waiting, Sleeping: st.Sleeping, Archived: st.Archived}
		if t := b.r.ActiveTaskForSubscriber(ctx, b.project, id); t != nil {
			row.TaskTitle = t.Title
		}
		out = append(out, row)
	}
	return out, nil
}

// Posts reads the newest public posts of this team: a message to a group, one Coral wrote itself, and a copy of another team's message are not the team's public posts and are left out.
// It reads a few more than n so that leaving those out still gives n when there are that many.
func (b *BoardSource) Posts(ctx context.Context, n int) ([]PostRow, error) {
	msgs, err := b.r.ListMessages(ctx, b.project, n*4+20, 0, 0)
	if err != nil {
		return nil, err
	}
	var out []PostRow
	for _, m := range msgs {
		if m.Project != b.project || m.TargetGroupID != nil || m.IsSystem || len(m.External) > 0 {
			continue
		}
		at, err := parseBoardTime(m.CreatedAt)
		if err != nil {
			continue
		}
		out = append(out, PostRow{Author: m.SubscriberID, Text: m.Content, At: at})
	}
	if len(out) > n {
		out = out[len(out)-n:]
	}
	return out, nil
}

// parseBoardTime reads a message's stored time (RFC 3339, with or without fractions).
func parseBoardTime(s string) (time.Time, error) { return time.Parse(time.RFC3339Nano, s) }
