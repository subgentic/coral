package server

import (
	"context"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// boardWorkersPromptBlock is the source of the workers block of an Orchestrator's board system prompt: the team's approved workers, "" when it has none (or the board cannot be read in a moment).
func boardWorkersPromptBlock(bs *board.Store) func(boardName string) string {
	return func(boardName string) string {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		workers, err := bs.ListWorkers(ctx, boardName)
		if err != nil {
			return ""
		}
		return board.WorkersBrief(workers)
	}
}
