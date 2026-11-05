package resources

import (
	"context"

	"github.com/subgentic/coral/internal/board"
)

// BoardPriorities ranks an agent by the most important task it has in progress on any board.
type BoardPriorities struct{ Store *board.Store }

// Of implements Priorities.
func (b BoardPriorities) Of(ctx context.Context, agent string) (int, string, int, error) {
	id, project, prio, ok, err := b.Store.ClaimedTaskAnywhere(ctx, agent)
	if err != nil || !ok {
		return 0, "", 0, err
	}
	return int(id), project, TaskRank(prio), nil
}
