package live

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	// sessions finds the session an agent is running now, and chat reads its transcript. Both are set by WithChat; without them no agent has a generation, so chat is unavailable for all.
	sessions SessionLookup
	chat     ChatReader
}

// SessionFacts is what is known of the session an agent is running: its id, its CLI, its folder, and the two times the store keeps for a run (when the row was made, and when Coral last typed its launch line).
// A restart and a resume make a new row; a wake stamps the launch time; a name reused later has another session id. Never in a frame.
type SessionFacts struct{ ID, Type, WorkingDir, Created, Launched string }

// SessionLookup gives the facts of the session a board subscription holds, false when there is none (a session that is gone).
type SessionLookup func(ctx context.Context, sessionName string) (SessionFacts, bool)

// ChatReader reads the newest n chat messages of a session (the transcript's allowlist, oldest first). false: no chat for it.
type ChatReader func(f SessionFacts, n int) ([]ChatRow, bool)

// WithChat gives the source the way to find a session and read its chat.
func (b *BoardSource) WithChat(s SessionLookup, c ChatReader) *BoardSource {
	b.sessions, b.chat = s, c
	return b
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
		facts, haveFacts := SessionFacts{}, false
		if b.sessions != nil && s.SessionName != "" {
			facts, haveFacts = b.sessions(ctx, s.SessionName)
		}
		row := AgentRow{Key: id, Generation: generation(s, facts, haveFacts), Type: facts.Type, Name: id, Role: s.JobTitle, Working: st.Working, Waiting: st.Waiting, Sleeping: st.Sleeping, Archived: st.Archived}
		if t := b.r.ActiveTaskForSubscriber(ctx, b.project, id); t != nil {
			row.TaskTitle = t.Title
		}
		out = append(out, row)
	}
	return out, nil
}

// Posts reads the newest public posts of this team: a message to a group, one Coral wrote itself, a copy of another team's message, a question to the Operator (or an answer to one) and a post a Hub user made are not the team's public posts and are left out.
// It reads a few more than n so that leaving those out still gives n when there are that many.
func (b *BoardSource) Posts(ctx context.Context, n int) ([]PostRow, error) {
	msgs, err := b.r.ListMessages(ctx, b.project, n*4+20, 0, 0)
	if err != nil {
		return nil, err
	}
	var out []PostRow
	for _, m := range msgs {
		if m.Project != b.project || m.TargetGroupID != nil || m.IsSystem || len(m.External) > 0 || m.Ask != nil || m.ReplyTo != nil || m.Origin != nil || m.HubUser != nil {
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

// generation is the identity of the run a chat pick is bound to: the board subscription's session and when it joined it, and the session the store has for it (its id, CLI, and the two times of its run). A restart
// and a resume make a new session row (new id and time), a wake stamps the launch time, a reused name is another session id, and a session that took the role over renews the join time: each changes it, so old chat
// never shows under a new session (MUST B). It is a hash, not the parts. No session facts means no generation, so no chat.
func generation(s board.Subscriber, f SessionFacts, ok bool) string {
	if !ok || f.ID == "" {
		return ""
	}
	joined := ""
	if s.SessionJoinedAt != nil {
		joined = *s.SessionJoinedAt
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{"coral-live-chat-generation", s.SessionName, joined, f.ID, f.Type, f.Created, f.Launched}, "\x00")))
	return hex.EncodeToString(sum[:16])
}

// Chat reads the newest n chat messages of the agent with this key, but only while it still runs the session the pick was bound to: any change of generation is ErrGenChanged and nothing is read.
func (b *BoardSource) Chat(ctx context.Context, key, gen string, n int) ([]ChatRow, error) {
	if gen == "" || b.sessions == nil || b.chat == nil {
		return nil, ErrGenChanged
	}
	subs, err := b.r.ListAllSubscribers(ctx, b.project)
	if err != nil {
		return nil, err
	}
	for _, s := range subs {
		if strings.TrimSpace(s.SubscriberID) != key {
			continue
		}
		if s.IsActive == 0 || s.SessionName == "" {
			return nil, ErrGenChanged
		}
		f, ok := b.sessions(ctx, s.SessionName)
		if generation(s, f, ok) != gen {
			return nil, ErrGenChanged
		}
		rows, ok := b.chat(f, n)
		if !ok {
			return nil, ErrGenChanged
		}
		return rows, nil
	}
	return nil, ErrGenChanged
}
