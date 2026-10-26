package board

import (
	"context"
)

// TaskArtifactCounter gives the exact artifact count of each task of a board that has any: what the task page's Artifacts section lists (a task's results and the uploads linked to it, each stored object
// once, as the team's Artifacts list collapses them). The server sets it (SetTaskArtifactCounter); the store asks it wherever it sends artifact_count, so every list says the same number the section does.
type TaskArtifactCounter func(ctx context.Context, project string) map[int64]int

// SetTaskArtifactCounter sets the exact counter. Without one the count is what the task's own workflow holds.
func (s *Store) SetTaskArtifactCounter(c TaskArtifactCounter) {
	if c == nil {
		s.artifactCounter.Store(nil)
		return
	}
	s.artifactCounter.Store(&c)
}

// exactArtifactCounts is the counter's answer for the board, or false when none is set.
func (s *Store) exactArtifactCounts(ctx context.Context, project string) (map[int64]int, bool) {
	c := s.artifactCounter.Load()
	if c == nil {
		return nil, false
	}
	return (*c)(ctx, project), true
}

// applyExactArtifactCounts sets ArtifactCount of the whole rows from the exact counter, a board at a time (the rows may be of several boards); with no counter the rows keep their workflow count.
func (s *Store) applyExactArtifactCounts(ctx context.Context, tasks []Task) {
	if s.artifactCounter.Load() == nil || len(tasks) == 0 {
		return
	}
	byBoard := map[string]map[int64]int{}
	for i := range tasks {
		counts, seen := byBoard[tasks[i].BoardID]
		if !seen {
			counts, _ = s.exactArtifactCounts(ctx, tasks[i].BoardID)
			byBoard[tasks[i].BoardID] = counts
		}
		if counts != nil {
			tasks[i].ArtifactCount = counts[tasks[i].ID]
		}
	}
}
