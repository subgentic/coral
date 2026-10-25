package store

import (
	"context"
	"strconv"
	"strings"
)

// ToolCallBucket is the number of tool calls one session made in one hour or day.
type ToolCallBucket struct {
	SessionID string `db:"session_id"`
	Bucket    string `db:"bucket"` // the first bucketLen characters of created_at: 13 is an hour (2026-10-25T14), 10 a day (2026-10-25)
	N         int    `db:"n"`
}

// ToolCallBuckets counts the tool calls of sessionIDs (the tool_use events their hooks recorded) in [since, until), by session and hour (bucketLen 13) or day (10). since and until are UTC times as
// "2006-01-02T15:04:05" (events are stored in UTC, so the text order is the time order). A CLI whose hooks record no tool use has no events here: the caller says "not measured" for it, not zero. It reads the
// (session_id, event_type, created_at) index (#7525).
func (d *DB) ToolCallBuckets(ctx context.Context, sessionIDs []string, since, until string, bucketLen int) ([]ToolCallBucket, error) {
	if bucketLen != 10 {
		bucketLen = 13
	}
	var out []ToolCallBucket
	for start := 0; start < len(sessionIDs); start += 400 {
		end := min(start+400, len(sessionIDs))
		ids := sessionIDs[start:end]
		args := make([]any, 0, len(ids)+2)
		for _, id := range ids {
			args = append(args, id)
		}
		args = append(args, since, until)
		var rows []ToolCallBucket
		q := `SELECT session_id, substr(created_at, 1, ` + strconv.Itoa(bucketLen) + `) AS bucket, COUNT(*) AS n FROM agent_events
			WHERE session_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + `) AND event_type = 'tool_use' AND created_at >= ? AND created_at < ?
			GROUP BY session_id, bucket`
		if err := d.Reader().SelectContext(ctx, &rows, q, args...); err != nil {
			return nil, err
		}
		out = append(out, rows...)
	}
	return out, nil
}
