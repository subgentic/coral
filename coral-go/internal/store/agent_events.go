// An agent's events (tool calls, state changes, goals, turns): the AgentEvent type and the store methods that record, redact and read them. Moved out of tasks.go (#8213), no code changed.

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/sessionstate"
)

// AgentEvent represents an event recorded for an agent.
type AgentEvent struct {
	ID         int64   `db:"id" json:"id"`
	AgentName  string  `db:"agent_name" json:"agent_name"`
	SessionID  *string `db:"session_id" json:"session_id,omitempty"`
	EventType  string  `db:"event_type" json:"event_type"`
	ToolName   *string `db:"tool_name" json:"tool_name,omitempty"`
	Summary    string  `db:"summary" json:"summary"`
	DetailJSON *string `db:"detail_json" json:"detail_json,omitempty"`
	CreatedAt  string  `db:"created_at" json:"created_at"`
	// DurationMs is how long the activity took, when the source reports it.
	DurationMs *int64 `db:"duration_ms" json:"duration_ms,omitempty"`
	// RefID is the activity's id at its source: tool_use_id for tool calls,
	// the API request id for thinking turns.
	RefID *string `db:"ref_id" json:"ref_id,omitempty"`
}

// MarshalJSON is the event as every API sends it. What a permission_request wants to do (its detail's "wants", #6622) is display text for the live row alone, which the
// live row's waiting_summary carries, and a Coral Hub viewer gets that like any other viewer (the operator's decision of 2026-10-24): no events list, search or feed carries it.
func (e AgentEvent) MarshalJSON() ([]byte, error) {
	type plain AgentEvent
	p := plain(e)
	if e.EventType == "permission_request" && e.DetailJSON != nil && strings.Contains(*e.DetailJSON, `"wants"`) {
		var d map[string]any
		if json.Unmarshal([]byte(*e.DetailJSON), &d) == nil {
			delete(d, "wants")
			if b, err := json.Marshal(d); err == nil {
				s := string(b)
				p.DetailJSON = &s
			}
		}
	}
	return json.Marshal(p)
}

// StateEvent is the event as the session state derivation reads it: its type,
// summary, kind (from its detail), tool and time (#3481).
func (e AgentEvent) StateEvent() sessionstate.Event {
	ev := sessionstate.NewEvent(e.EventType, e.Summary, e.DetailJSON)
	if e.ToolName != nil {
		ev.ToolName = *e.ToolName
	}
	if e.EventType == "tool_use" && e.RefID != nil {
		ev.ToolUseID = *e.RefID // the call this PostToolUse is for
	}
	if t, err := time.Parse(time.RFC3339Nano, e.CreatedAt); err == nil {
		ev.At = t
	}
	return ev
}

// redactAgentEvent redacts an event before it is stored (#3763, secrets audit #3762 finding 1):
// a tool call's summary and detail hold the whole command ("curl -H 'Authorization: Bearer
// ...'", "export TOKEN=...", "psql postgres://user:pw@..."), and sessions.db is what gets
// backed up and attached. Coral Hub's redactor runs once here, at the write, for every writer
// (the hooks' events, goals, thinking, auto-accept): the summary as text, the detail by its JSON
// structure (each value scanned with its key). What can't be checked is not stored (#3808).
func redactAgentEvent(event *AgentEvent) {
	red := eventRedactor()
	if s, err := red.Text([]byte(event.Summary)); err == nil {
		event.Summary = string(s)
	} else {
		event.Summary = uncheckedEvent
	}
	if event.DetailJSON != nil {
		if d, err := red.Document([]byte(*event.DetailJSON)); err == nil {
			ds := string(d)
			event.DetailJSON = &ds
		} else {
			event.DetailJSON = nil
		}
	}
}

// eventRedactor is the redactor events are stored through (a test replaces it).
var eventRedactor = secrets.Redactor

// uncheckedEvent is stored in place of an event summary the redactor could not check.
const uncheckedEvent = "[this event could not be checked for secrets, so it was not stored]"

// InsertAgentEvent inserts an event and auto-prunes to 500 per agent.
// CreatedAt is stamped with the current time unless the caller set it, which
// transcript-derived events do so they sort where they actually happened.
func (s *TaskStore) InsertAgentEvent(ctx context.Context, event *AgentEvent) (*AgentEvent, error) {
	if event.CreatedAt == "" {
		event.CreatedAt = nowUTC()
	}
	redactAgentEvent(event)

	result, err := s.db.ExecContext(ctx,
		`INSERT INTO agent_events (agent_name, session_id, event_type, tool_name, summary, detail_json, created_at, duration_ms, ref_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		event.AgentName, event.SessionID, event.EventType, event.ToolName,
		event.Summary, event.DetailJSON, event.CreatedAt, event.DurationMs, event.RefID)
	if err != nil {
		return nil, err
	}
	if id, err := result.LastInsertId(); err != nil {
		log.Printf("[store] get event insert ID: %v", err)
	} else {
		event.ID = id
	}

	// Auto-prune to 500 events per session (best-effort). Session-scoped
	// retention prevents activity from a sibling agent in the same worktree
	// from erasing an unresolved attention notification.
	keep := agentEventKeep
	if n := s.eventKeep.Load(); n > 0 {
		keep = int(n)
	}
	pruneQuery := `DELETE FROM agent_events WHERE agent_name = ? AND id NOT IN
		 (SELECT id FROM agent_events WHERE agent_name = ? ORDER BY id DESC LIMIT ?)`
	pruneArgs := []any{event.AgentName, event.AgentName, keep}
	if event.SessionID != nil && *event.SessionID != "" {
		pruneQuery = `DELETE FROM agent_events WHERE agent_name = ? AND session_id = ? AND id NOT IN
			 (SELECT id FROM agent_events WHERE agent_name = ? AND session_id = ? ORDER BY id DESC LIMIT ?)`
		pruneArgs = []any{event.AgentName, *event.SessionID, event.AgentName, *event.SessionID, keep}
	}
	if _, err := s.db.ExecContext(ctx, pruneQuery, pruneArgs...); err != nil {
		log.Printf("[store] event prune failed for %s: %v", event.AgentName, err)
	}

	return event, nil
}

// AgentEventExists reports whether a session already has an event of this
// type for the given source id. Transcript-derived events use it to stay
// idempotent across re-reads and restarts.
func (s *TaskStore) AgentEventExists(ctx context.Context, sessionID, eventType, refID string) (bool, error) {
	var n int
	err := s.reader().GetContext(ctx, &n,
		`SELECT COUNT(*) FROM agent_events WHERE session_id = ? AND event_type = ? AND ref_id = ?`,
		sessionID, eventType, refID)
	return n > 0, err
}

// ListAgentEvents returns recent events for an agent.
// If agentName is empty, events are not filtered by agent (useful for history queries by session).
func (s *TaskStore) ListAgentEvents(ctx context.Context, agentName string, limit int, sessionID *string) ([]AgentEvent, error) {
	var whereClauses []string
	var args []interface{}
	if agentName != "" {
		whereClauses = append(whereClauses, "agent_name = ?")
		args = append(args, agentName)
	}
	if sessionID != nil {
		whereClauses = append(whereClauses, "session_id = ?")
		args = append(args, *sessionID)
	}
	where := ""
	if len(whereClauses) > 0 {
		where = " WHERE " + strings.Join(whereClauses, " AND ")
	}
	args = append(args, limit)
	var events []AgentEvent
	err := s.reader().SelectContext(ctx, &events,
		`SELECT id, agent_name, session_id, event_type, tool_name, summary, detail_json, created_at, duration_ms, ref_id
		 FROM agent_events`+where+` ORDER BY created_at DESC, id DESC LIMIT ?`,
		args...)
	return events, err
}

// GetAgentEventCounts returns tool usage counts for an agent.
// If agentName is empty, counts are not filtered by agent.
func (s *TaskStore) GetAgentEventCounts(ctx context.Context, agentName string, sessionID *string) ([]ToolCount, error) {
	var whereClauses []string
	var args []interface{}
	if agentName != "" {
		whereClauses = append(whereClauses, "agent_name = ?")
		args = append(args, agentName)
	}
	if sessionID != nil {
		whereClauses = append(whereClauses, "session_id = ?")
		args = append(args, *sessionID)
	}
	whereClauses = append(whereClauses, "tool_name IS NOT NULL")
	where := " WHERE " + strings.Join(whereClauses, " AND ")
	var counts []ToolCount
	err := s.reader().SelectContext(ctx, &counts,
		`SELECT tool_name, COUNT(*) as count FROM agent_events`+where+`
		 GROUP BY tool_name ORDER BY count DESC`,
		args...)
	return counts, err
}

// sessionIDsJSON encodes ids, without duplicates, for json_each. Unlike
// IN (...), joining json_each repeats rows for a repeated id.
func sessionIDsJSON(sessionIDs []string) (string, error) {
	seen := make(map[string]bool, len(sessionIDs))
	unique := make([]string, 0, len(sessionIDs))
	for _, id := range sessionIDs {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	b, err := json.Marshal(unique)
	return string(b), err
}

// SessionsWithAnyEvent is the sessions among sessionIDs that have recorded any event at all, a status or a goal too: the agent's CLI has reported, so it is no longer "starting" (#6745: a scheduled run
// whose events are all of the kinds GetLatestEventTypes leaves out never cleared it).
func (s *TaskStore) SessionsWithAnyEvent(ctx context.Context, sessionIDs []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(sessionIDs) == 0 {
		return out, nil
	}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return nil, err
	}
	var rows []string
	if err := s.reader().SelectContext(ctx, &rows,
		`SELECT s.value FROM json_each(?) s WHERE EXISTS (SELECT 1 FROM agent_events e WHERE e.session_id = s.value)`, ids); err != nil {
		return nil, err
	}
	for _, id := range rows {
		out[id] = true
	}
	return out, nil
}

// GetLatestEventTypes returns the latest (event_type, summary) per session (excluding status/goal/confidence).
func (s *TaskStore) GetLatestEventTypes(ctx context.Context, sessionIDs []string) (map[string][2]string, error) {
	if len(sessionIDs) == 0 {
		return map[string][2]string{}, nil
	}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return nil, err
	}
	// One backward index seek per session (idx_agent_events_session_time)
	// instead of sorting every session's full history. Ties on created_at go
	// to the newest id.
	var rows []struct {
		SessionID string `db:"session_id"`
		EventType string `db:"event_type"`
		Summary   string `db:"summary"`
	}
	if err := s.reader().SelectContext(ctx, &rows,
		`SELECT session_id, event_type, summary FROM agent_events WHERE id IN (
		   SELECT (SELECT e.id FROM agent_events e
		           WHERE e.session_id = s.value AND e.event_type NOT IN ('status', 'goal', 'confidence')
		           ORDER BY e.created_at DESC, e.id DESC LIMIT 1)
		   FROM json_each(?) s)`, ids); err != nil {
		return nil, err
	}
	result := make(map[string][2]string, len(rows))
	for _, r := range rows {
		result[r.SessionID] = [2]string{r.EventType, r.Summary}
	}
	return result, nil
}

// GetSessionStateEvents returns the ordered events that participate in live
// state derivation. Keeping this in the store makes the derivation restart
// safe: notification state is reconstructed from the event log rather than an
// in-memory latch. Events are returned oldest first for each session.
//
// Only the suffix that decides the state is returned: the newest boundary
// (stop, prompt_submit, tool_use, session_reset, auto_accept or session_end) and
// the events after it. sessionstate.Derive resets on every boundary, so earlier
// events cannot change its result, and the suffix keeps the newest timestamp the
// transcript merge compares against. One exception (#3481): a tool_use does not
// close another tool's open request (Claude runs tools in parallel), so while a
// permission_request is open since the newest turn boundary (all but tool_use),
// the suffix starts at the earliest such request.
func (s *TaskStore) GetSessionStateEvents(ctx context.Context, sessionIDs []string) (map[string][]AgentEvent, error) {
	if len(sessionIDs) == 0 {
		return map[string][]AgentEvent{}, nil
	}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return nil, err
	}
	var rows []AgentEvent
	if err := s.reader().SelectContext(ctx, &rows,
		`WITH turn AS (
		   SELECT s.value AS sid,
		          (SELECT x.id FROM agent_events x
		           WHERE x.session_id = s.value
		             AND x.event_type IN ('stop', 'prompt_submit', 'session_reset', 'auto_accept', 'session_end')
		           ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS tid
		   FROM json_each(?) s),
		 boundary AS (
		   SELECT turn.sid,
		          COALESCE(
		            (SELECT x.id FROM agent_events x
		             WHERE x.session_id = turn.sid AND x.event_type = 'permission_request'
		               AND (turn.tid IS NULL OR (x.created_at, x.id) > ((SELECT t.created_at FROM agent_events t WHERE t.id = turn.tid), turn.tid))
		             ORDER BY x.created_at, x.id LIMIT 1),
		            (SELECT x.id FROM agent_events x
		             WHERE x.session_id = turn.sid
		               AND x.event_type IN ('stop', 'prompt_submit', 'tool_use', 'session_reset', 'auto_accept', 'session_end')
		             ORDER BY x.created_at DESC, x.id DESC LIMIT 1)) AS bid
		   FROM turn)
		 SELECT e.id, e.agent_name, e.session_id, e.event_type, e.tool_name, e.summary, e.detail_json, e.created_at, e.ref_id
		 FROM boundary
		 JOIN agent_events b ON b.id = boundary.bid
		 JOIN agent_events e ON e.session_id = boundary.sid
		 WHERE e.event_type IN ('notification', 'stop', 'prompt_submit', 'tool_use', 'session_reset', 'auto_accept', 'permission_request', 'request_resolved', 'session_end')
		   AND (e.created_at, e.id) >= (b.created_at, b.id)
		 UNION ALL
		 SELECT e.id, e.agent_name, e.session_id, e.event_type, e.tool_name, e.summary, e.detail_json, e.created_at, e.ref_id
		 FROM boundary
		 JOIN agent_events e ON e.session_id = boundary.sid
		 WHERE boundary.bid IS NULL AND e.event_type IN ('notification', 'permission_request', 'request_resolved')
		 ORDER BY 3, 8, 1`, ids); err != nil {
		return nil, err
	}
	result := make(map[string][]AgentEvent, len(sessionIDs))
	for _, id := range sessionIDs {
		result[id] = []AgentEvent{}
	}
	for _, event := range rows {
		if event.SessionID != nil {
			result[*event.SessionID] = append(result[*event.SessionID], event)
		}
	}
	return result, nil
}

// GetLatestGoalEvent returns the newest goal event for a session, or nil.
func (s *TaskStore) GetLatestGoalEvent(ctx context.Context, sessionID string) (*AgentEvent, error) {
	var ev AgentEvent
	err := s.reader().GetContext(ctx, &ev,
		`SELECT * FROM agent_events WHERE session_id = ? AND event_type = 'goal'
		 ORDER BY created_at DESC, id DESC LIMIT 1`, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ev, nil
}

// LatestStopFailure returns the error text of a session's newest turn end when that turn
// ended in an API error (the StopFailure hook: event "stop" with detail failed). ok is false when
// the newest turn end was a normal one, or there is none (#3613). The text is the CLI's own and
// stays on the server: callers map it to a fixed label.
func (s *TaskStore) LatestStopFailure(ctx context.Context, sessionID string) (text string, ok bool, err error) {
	var detail sql.NullString
	err = s.reader().GetContext(ctx, &detail,
		`SELECT detail_json FROM agent_events WHERE session_id = ? AND event_type = 'stop'
		 ORDER BY created_at DESC, id DESC LIMIT 1`, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil || !detail.Valid {
		return "", false, err
	}
	var d struct {
		Failed bool   `json:"failed"`
		Error  string `json:"error"`
	}
	if json.Unmarshal([]byte(detail.String), &d) != nil || !d.Failed {
		return "", false, nil
	}
	return d.Error, true, nil
}

// The states of a session's current turn, as RunTurn reads them from its stored events (#7090).
const (
	TurnNone    = ""        // no prompt of this session was submitted yet (or it was reset since): nothing to finish
	TurnWorking = "working" // a prompt was submitted and its turn has not ended: a stop is awaited, or the agent went on after one
	TurnDone    = "done"    // the turn ended normally (a stop that did not fail)
	TurnFailed  = "failed"  // the turn ended in an error (StopFailure: a stop with detail failed)
)

// RunTurn is how the current turn of a session stands, and, once it has ended, the time of the stop that ended it.
type RunTurn struct {
	State string
	At    string
}

// SessionTurn says how a session's current turn stands, from two bounded reads of its stored events (#7090): the newest prompt_submit or session_reset, which opens or resets the turn, and the newest tool call,
// request or stop after it. A prompt starts a turn; the newest of what the agent did since is the state: a stop ends it (normally, or in an error when its detail says failed), a tool call or a request is
// the turn going on (also when it came after an earlier stop: the agent went on). A reset, or no prompt at all, is none: a stop with no prompt before it (a startup, a stop of something else) ends nothing.
// Only rows after the prompt are read, and only the newest of them: a run with thousands of tool calls costs the same as one with none. Events are kept to the newest few hundred per session: a turn whose
// prompt was pruned reads as none, never as ended. An unreadable store is an error, never a state.
func (s *TaskStore) SessionTurn(ctx context.Context, sessionID string) (RunTurn, error) {
	var open struct {
		ID   int64  `db:"id"`
		Type string `db:"event_type"`
	}
	err := s.reader().GetContext(ctx, &open,
		`SELECT id, event_type FROM agent_events WHERE session_id = ? AND event_type IN ('prompt_submit', 'session_reset') ORDER BY id DESC LIMIT 1`, sessionID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && open.Type != "prompt_submit") {
		return RunTurn{}, nil
	}
	if err != nil {
		return RunTurn{}, err
	}
	var last struct {
		Type   string         `db:"event_type"`
		Detail sql.NullString `db:"detail_json"`
		At     string         `db:"created_at"`
	}
	err = s.reader().GetContext(ctx, &last,
		`SELECT event_type, detail_json, created_at FROM agent_events WHERE session_id = ? AND id > ? AND event_type IN ('stop', 'tool_use', 'permission_request') ORDER BY id DESC LIMIT 1`, sessionID, open.ID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && last.Type != "stop") {
		return RunTurn{State: TurnWorking}, nil
	}
	if err != nil {
		return RunTurn{}, err
	}
	turn := RunTurn{State: TurnDone, At: last.At}
	var d struct {
		Failed bool `json:"failed"`
	}
	if last.Detail.Valid && json.Unmarshal([]byte(last.Detail.String), &d) == nil && d.Failed {
		turn.State = TurnFailed
	}
	return turn, nil
}

// GetLatestGoals returns the latest goal summary per session.
func (s *TaskStore) GetLatestGoals(ctx context.Context, sessionIDs []string) (map[string]string, error) {
	if len(sessionIDs) == 0 {
		return map[string]string{}, nil
	}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		SessionID string `db:"session_id"`
		Summary   string `db:"summary"`
	}
	if err := s.reader().SelectContext(ctx, &rows,
		`SELECT session_id, summary FROM agent_events WHERE id IN (
		   SELECT (SELECT e.id FROM agent_events e
		           WHERE e.session_id = s.value AND e.event_type = 'goal'
		           ORDER BY e.created_at DESC, e.id DESC LIMIT 1)
		   FROM json_each(?) s)`, ids); err != nil {
		return nil, err
	}
	result := make(map[string]string, len(rows))
	for _, r := range rows {
		result[r.SessionID] = r.Summary
	}
	return result, nil
}

// ClearAgentEvents deletes all events for an agent, optionally scoped by session.
func (s *TaskStore) ClearAgentEvents(ctx context.Context, agentName string, sessionID *string) error {
	filter, filterArgs := sessionFilter(sessionID)
	args := append([]interface{}{agentName}, filterArgs...)
	_, err := s.db.ExecContext(ctx,
		"DELETE FROM agent_events WHERE agent_name = ?"+filter,
		args...)
	return err
}
