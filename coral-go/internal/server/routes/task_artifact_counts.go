package routes

import (
	"context"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// The artifact count of a task (#8579, #8591) is what its page's Artifacts section lists: GET /api/board/{p}/artifacts?task=<id>, the team's list collapsed by stored object, with the uploads linked to
// the task. taskArtifactCounts builds that list the way the route does and counts it by task; the store asks it (board.TaskArtifactCounter) wherever a task list, the task query or a goal's page sends
// artifact_count. A scan costs what the Artifacts tab's does, so an answer is kept for a few seconds per board: the lists are polled.

// taskCountTTL is how long a board's counts are kept; a variable so a test that changes things between two reads can ask for none.
var taskCountTTL = 3 * time.Second

type taskCountEntry struct {
	at     time.Time
	counts map[int64]int
}

type taskCountCache struct {
	mu      sync.Mutex
	entries map[string]taskCountEntry
}

const taskCountCacheLimit = 256 // boards; the map is dropped when full

// taskArtifactCounts is the number of artifacts each task of the board has, the section's count; a task with none is absent. A scan that fails answers nil: the lists then say nothing rather than a wrong number.
func (h *BoardHandler) taskArtifactCounts(ctx context.Context, project string) map[int64]int {
	now := time.Now()
	h.taskCounts.mu.Lock()
	if e, ok := h.taskCounts.entries[project]; ok && now.Sub(e.at) < taskCountTTL {
		h.taskCounts.mu.Unlock()
		return e.counts
	}
	h.taskCounts.mu.Unlock()

	subscribers, err := h.bs.TeamSubscriberSessions(ctx, project)
	if err != nil {
		return nil
	}
	tasks, _, err := h.bs.ListTeamArtifactTasksQuery(ctx, board.TeamArtifactQuery{Project: project, Limit: board.MaxTeamArtifactTaskScan, Subscribers: subscribers})
	if err != nil {
		return nil
	}
	items := collectTeamArtifacts(project, tasks, subscribers, "")
	items = h.uploads.merge(items, h.coralDir, teamUploadSessions(tasks, subscribers))
	items = h.mergeCrossTeamRows(items, project)
	h.linkUploadTasks(ctx, project, items)
	counts := map[int64]int{}
	for _, it := range items {
		if it.TaskID > 0 {
			counts[it.TaskID]++
		}
	}
	h.taskCounts.mu.Lock()
	if h.taskCounts.entries == nil || len(h.taskCounts.entries) >= taskCountCacheLimit {
		h.taskCounts.entries = map[string]taskCountEntry{}
	}
	h.taskCounts.entries[project] = taskCountEntry{at: now, counts: counts}
	h.taskCounts.mu.Unlock()
	return counts
}
