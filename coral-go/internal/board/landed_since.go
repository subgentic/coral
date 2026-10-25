package board

import (
	"context"
	"sort"
)

// LandedRecord is one commit the merge queue recorded as landed (mark-landed, #5689): who marked it, when, and for which task. The analytics' "landed by" detail (#7525): a commit pushed outside the queue is in
// no record, so this is extra detail beside the repository's own history, never the count.
type LandedRecord struct {
	TaskID   int64  `json:"task_id"`
	SHA      string `json:"sha"`
	LandedBy string `json:"landed_by"`
	LandedAt string `json:"landed_at"`
}

// maxLandedScan bounds how many tasks with landed commits one read looks at.
const maxLandedScan = 2000

// LandedSince lists the commits the queue marked landed on a board at or after since (an RFC 3339 UTC time; "" is all), newest first, at most limit (0 is 500). A task is read only when its workflow holds
// a landed-commit row.
func (s *Store) LandedSince(ctx context.Context, project, since string, limit int) ([]LandedRecord, error) {
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	rows, err := s.reader().QueryxContext(ctx, `SELECT t.id, w.data FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND w.data LIKE '%"landed-commit"%' ORDER BY t.id DESC LIMIT ?`, project, maxLandedScan)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LandedRecord{}
	for rows.Next() {
		var id int64
		var data string
		if err := rows.Scan(&id, &data); err != nil {
			return nil, err
		}
		w, err := decodeWorkflow(data, true)
		if err != nil {
			continue
		}
		for _, a := range w.Artifacts {
			if a.Kind != landedCommitKind || !shaRe.MatchString(a.Revision) || a.LandedAt == "" || (since != "" && a.LandedAt < since) {
				continue
			}
			out = append(out, LandedRecord{TaskID: id, SHA: a.Revision, LandedBy: a.LandedBy, LandedAt: a.LandedAt})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LandedAt > out[j].LandedAt })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
