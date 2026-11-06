package resources

import (
	"context"

	"github.com/subgentic/coral/internal/board"
)

// BoardPriorities ranks an agent by the most important task it has in progress on any board.
type BoardPriorities struct{ Store *board.Store }

// Of implements Priorities.
func (b BoardPriorities) Of(ctx context.Context, agent string) (int, string, int, error) {
	var id int64
	var project, prio string
	var ok bool
	var err error
	if session := SessionName(ctx); session != "" { // the claim says which session it is from: the task is from a board that session is on (#13833)
		var boards []string
		if boards, err = b.Store.BoardsOfSession(ctx, session); err == nil {
			id, project, prio, ok, err = b.Store.ClaimedTaskOnBoards(ctx, agent, boards)
		}
	} else {
		id, project, prio, ok, err = b.Store.ClaimedTaskAnywhere(ctx, agent)
	}
	if err != nil || !ok {
		return 0, "", 0, err
	}
	return int(id), project, TaskRank(prio), nil
}

type sessionKey struct{}

// WithSession says which agent session a claim is made from, by its name on the board, so its task is looked up on the boards that session is on and not on another board's agent of the same name (#13833).
func WithSession(ctx context.Context, name string) context.Context {
	return context.WithValue(ctx, sessionKey{}, name)
}

// SessionName is the session WithSession set, or "".
func SessionName(ctx context.Context) string {
	s, _ := ctx.Value(sessionKey{}).(string)
	return s
}
