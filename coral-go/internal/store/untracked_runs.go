package store

import "context"

// A job run whose agent never wrote a line has a session id but no row in the chat list, so Active now and All chats did
// not show it at all (#17447). It is listed for a week, as long as it is a run that is starting or failed.
const untrackedRunWhere = `sr.session_id IS NOT NULL AND sr.session_id <> '' AND sr.status IN ('pending','running','failed')
 AND NOT EXISTS (SELECT 1 FROM session_index si WHERE si.session_id = sr.session_id)
 AND COALESCE(sr.finished_at, sr.started_at, sr.scheduled_at) >= strftime('%Y-%m-%dT%H:%M:%S','now','-7 days')`

// UntrackedRun is a job run with no conversation row yet.
type UntrackedRun struct {
	SessionID string  `db:"session_id"`
	JobName   string  `db:"job_name"`
	AgentType string  `db:"agent_type"`
	Status    string  `db:"status"`
	At        string  `db:"at"`
	ErrorMsg  *string `db:"error_msg"`
}

// Starting is whether the run may still start (pending or running with no conversation yet); otherwise it failed.
func (r UntrackedRun) Starting() bool { return r.Status != "failed" }

// ListUntrackedRuns reads the job runs that have no conversation row, newest first.
func (s *SessionStore) ListUntrackedRuns(ctx context.Context) ([]UntrackedRun, error) {
	var rows []UntrackedRun
	err := s.reader().SelectContext(ctx, &rows, `SELECT sr.session_id, COALESCE(j.name,'') AS job_name, COALESCE(j.agent_type,'claude') AS agent_type, sr.status,
 COALESCE(sr.finished_at, sr.started_at, sr.scheduled_at) AS at, sr.error_msg
 FROM scheduled_runs sr LEFT JOIN scheduled_jobs j ON j.id = sr.job_id WHERE `+untrackedRunWhere+` ORDER BY at DESC LIMIT 100`)
	return rows, err
}
