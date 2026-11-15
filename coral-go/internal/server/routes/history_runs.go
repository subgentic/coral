package routes

import (
	"context"

	"github.com/subgentic/coral/internal/store"
)

// untrackedRunRows are the job runs with no conversation yet, as chat rows (#17447): Active now and All chats list them with
// their state, and opening one says why there is nothing to read. None when a filter that cannot match a run is on.
func (h *HistoryHandler) untrackedRunRows(ctx context.Context, p store.SessionListParams) []map[string]any {
	if p.Search != "" || len(p.TagIDs) > 0 || len(p.SourceTypes) > 0 || p.DateFrom != "" || p.DateTo != "" || p.MinDurationSec != nil ||
		p.MaxDurationSec != nil || p.AgentName != "" || p.Starred || p.Archived || p.WithNotes {
		return nil
	}
	runs, err := h.ss.ListUntrackedRuns(ctx)
	if err != nil {
		return nil
	}
	rows := make([]map[string]any, 0, len(runs))
	for _, r := range runs {
		if p.Active && !r.Starting() {
			continue
		}
		state, title := "Did not start", r.JobName
		if r.Starting() {
			state = "Starting"
		}
		if title == "" {
			title = "Job run"
		}
		row := map[string]any{
			"session_id": r.SessionID, "starred": false, "archived": false, "active": r.Starting(), "source_type": r.AgentType,
			"first_timestamp": r.At, "last_timestamp": r.At, "message_count": 0, "summary": "", "first_user_message": "", "summary_title": "",
			"title": title, "has_notes": false, "tags": []store.Tag{}, "branch": "", "duration_sec": 0, "agent_name": "", "display_name": title,
			"type": "agent", "run_state": state,
		}
		rows = append(rows, row)
	}
	return rows
}
