package routes

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// The artifact count of a task (#8579, #8591) is what its page's Artifacts section lists: GET /api/board/{p}/artifacts?task=<id>, the team's list collapsed by stored object, with the uploads linked to
// the task. taskArtifactCounts builds that list the way the route does and counts it by task; the store asks it (board.TaskArtifactCounter) wherever a task list, the task query or a goal's page sends
// artifact_count. A scan costs what the Artifacts tab's does, so an answer is kept for a few seconds per board: the lists are polled.

// taskCountTTL is how long a board's counts are kept; a variable so a test that changes things between two reads can ask for none.
var taskCountTTL = 3 * time.Second

// artifactGeneration counts the changes that can change a task's count outside the board's own list (an upload, a task completed with result files): an answer kept from an earlier generation is not used (#12855). A package
// counter, not a per-handler one: the upload route and the board's lists are different handlers.
var artifactGeneration atomic.Uint64

// afterTaskCountScan is a test's hook between a scan and the storing of its answer: where a change made during the scan lands.
var afterTaskCountScan func()

// noteArtifactsChanged drops every kept count: an upload, or a completion with result files, was just stored.
func noteArtifactsChanged() { artifactGeneration.Add(1) }

type taskCountEntry struct {
	at      time.Time
	gen     uint64
	counts  map[int64]int
	uploads map[int64][]teamArtifact // the uploads each task is linked to, for the task's own read (#12755)
}

type taskCountCache struct {
	mu      sync.Mutex
	entries map[string]taskCountEntry
}

const taskCountCacheLimit = 256 // boards; the map is dropped when full

// taskArtifactCounts is the number of artifacts each task of the board has, the section's count; a task with none is absent. A scan that fails answers nil: the lists then say nothing rather than a wrong number.
func (h *BoardHandler) taskArtifactCounts(ctx context.Context, project string) map[int64]int {
	now := time.Now()
	gen := artifactGeneration.Load() // before the scan: a change during it makes the answer stale on its first use
	h.taskCounts.mu.Lock()
	if e, ok := h.taskCounts.entries[project]; ok && e.gen == gen && now.Sub(e.at) < taskCountTTL {
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
	uploads := map[int64][]teamArtifact{}
	for _, it := range items {
		if it.TaskID > 0 {
			counts[it.TaskID]++
			if it.uploadTask == it.TaskID { // an upload the task is linked to by its record, whatever the task's state
				uploads[it.TaskID] = append(uploads[it.TaskID], it)
			}
		}
	}
	if afterTaskCountScan != nil {
		afterTaskCountScan()
	}
	h.taskCounts.mu.Lock()
	if h.taskCounts.entries == nil || len(h.taskCounts.entries) >= taskCountCacheLimit {
		h.taskCounts.entries = map[string]taskCountEntry{}
	}
	h.taskCounts.entries[project] = taskCountEntry{at: now, gen: gen, counts: counts, uploads: uploads}
	h.taskCounts.mu.Unlock()
	return counts
}

// forgetTaskCounts drops every board's kept counts and upload lists: an upload was just stored, so a task's read made in the next seconds must see it (#12755), not the list kept for taskCountTTL.
func (h *BoardHandler) forgetTaskCounts() {
	h.taskCounts.mu.Lock()
	h.taskCounts.entries = nil
	h.taskCounts.mu.Unlock()
}

// taskUploads are the uploads an agent linked to the task (its record names it), whatever the task's state: the task's own read lists them with its result files, so `coral-board task show` finds what a reviewer asks for (#12755).
// Kept for a few seconds with the counts; empty when the scan fails.
func (h *BoardHandler) taskUploads(ctx context.Context, project string, taskID int64) []teamArtifact {
	h.taskArtifactCounts(ctx, project) // makes (or reuses) the board's entry
	h.taskCounts.mu.Lock()
	defer h.taskCounts.mu.Unlock()
	if e, ok := h.taskCounts.entries[project]; ok {
		return append([]teamArtifact(nil), e.uploads[taskID]...)
	}
	return nil
}
