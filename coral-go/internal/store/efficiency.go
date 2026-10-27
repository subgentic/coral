package store

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Reads for the Analytics view's efficiency measures (#8915): the usage of a window by session, model and thinking level; the commits agents recorded in it; and each session's latest branch. The
// grouping and the sums are internal/efficiency's.

// EfficiencyUsageRow is the tokens (input + output) and cost of one session at one model and thinking level in a window. Team is the board the row was recorded on, else the session's own.
type EfficiencyUsageRow struct {
	SessionID string  `db:"session_id"`
	AgentName string  `db:"agent_name"`
	AgentType string  `db:"agent_type"`
	Team      string  `db:"team"`
	Model     string  `db:"model"`
	Thinking  string  `db:"thinking"`
	Tokens    int64   `db:"tokens"`
	CostUSD   float64 `db:"cost_usd"`
}

// EfficiencyUsage reads the usage recorded in [since, until) (RFC 3339 UTC, until "" for no end): raw rows and rolled-up hourly rows alike, a session counted once however it was read (the same rule
// as every other usage total). A row with no model or no thinking level has "" there.
//
// coarse (#9442) says the caller does not read the thinking level: the rolled-up rows then come from the day aggregate where it can answer (usageCoarseRelationUntil, about 24 times fewer rows than the
// hourly ones: the clean whole days of the window; the day since and the day until fall in are read from their rows), and Thinking is "" in every row.
func (s *TokenUsageStore) EfficiencyUsage(ctx context.Context, since, until string, coarse bool) ([]EfficiencyUsageRow, error) {
	if coarse {
		return s.efficiencyUsageCoarse(ctx, since, until)
	}
	q := `SELECT t.session_id, COALESCE(NULLIF(ls.display_name, ''), MIN(t.agent_name), '') AS agent_name, t.agent_type,
	             COALESCE(NULLIF(t.board_name, ''), ls.board_name, '') AS team, COALESCE(t.model, '') AS model, COALESCE(t.thinking, '') AS thinking,
	             COALESCE(SUM(t.input_tokens + t.output_tokens), 0) AS tokens, COALESCE(SUM(t.cost_usd), 0) AS cost_usd
	      FROM token_usage_all t LEFT JOIN live_sessions ls ON ls.session_id = t.session_id
	      WHERE ` + usageDedup("t.") + ` AND t.recorded_at >= ?`
	args := []any{windowBound(since)}
	if until != "" {
		q += ` AND t.recorded_at < ?`
		args = append(args, windowBound(until))
	}
	// the grouping is by the usage row's own columns: the live session has a model and a thinking level of its own, which are not these
	q += ` GROUP BY t.session_id, t.agent_type, COALESCE(NULLIF(t.board_name, ''), ls.board_name, ''), COALESCE(t.model, ''), COALESCE(t.thinking, '')
	       ORDER BY t.session_id, COALESCE(t.model, ''), COALESCE(t.thinking, '')`
	var rows []EfficiencyUsageRow
	err := s.db.Reader().SelectContext(ctx, &rows, q, args...)
	return rows, err
}

// efficiencyUsageCoarse is EfficiencyUsage over the coarse relation: the same groups without the thinking level, summed from the day aggregate for the clean whole days.
func (s *TokenUsageStore) efficiencyUsageCoarse(ctx context.Context, since, until string) ([]EfficiencyUsageRow, error) {
	rel, args := usageCoarseRelationUntil(ctx, s.db.Reader(), since, until)
	q := `SELECT t.session_id, COALESCE(NULLIF(ls.display_name, ''), MIN(t.agent_name), '') AS agent_name, t.agent_type,
	             COALESCE(NULLIF(t.board_name, ''), ls.board_name, '') AS team, COALESCE(t.model, '') AS model, '' AS thinking,
	             COALESCE(SUM(t.input_tokens + t.output_tokens), 0) AS tokens, COALESCE(SUM(t.cost_usd), 0) AS cost_usd
	      FROM ` + rel + ` t LEFT JOIN live_sessions ls ON ls.session_id = t.session_id
	      WHERE ` + usageDedup("t.")
	if until != "" {
		q += ` AND t.recorded_at < ?`
		args = append(args, windowBound(until))
	}
	q += ` GROUP BY t.session_id, t.agent_type, COALESCE(NULLIF(t.board_name, ''), ls.board_name, ''), COALESCE(t.model, '')
	       ORDER BY t.session_id, COALESCE(t.model, '')`
	var rows []EfficiencyUsageRow
	err := s.db.Reader().SelectContext(ctx, &rows, q, args...)
	return rows, err
}

// EfficiencyCommit is a commit, with the sessions whose snapshots saw it, first to last.
type EfficiencyCommit struct {
	Hash string
	At   time.Time // the commit's own (author) time: a rebased, amended or cherry-picked copy keeps it
	Seen []CommitSighting
	// AuthorName and AuthorHash are who made it (a name, and the IdentityHasher pseudonym of their email); empty for a commit snapshotted before they were recorded.
	AuthorName string
	AuthorHash string
}

// CommitSighting is one session's snapshot of a commit.
type CommitSighting struct {
	SessionID string
	AgentName string
	AgentType string
	Branch    string
	// IdentName and IdentHash are the git identity configured in the checkout the session snapshotted it in; empty when none was recorded.
	IdentName string
	IdentHash string
}

// MadeBy says whether the commit is one the sighting's session could have made, by who made it: its author is the agent (by the agent's name, as agents commit under their role) or the identity
// configured in the checkout (by name or by email hash). A commit whose author was never recorded can be anyone's: it is credited as before.
func (c EfficiencyCommit) MadeBy(sg CommitSighting, agentName string) bool {
	if c.AuthorName == "" && c.AuthorHash == "" {
		return true
	}
	if c.AuthorHash != "" && c.AuthorHash == sg.IdentHash {
		return true
	}
	for _, name := range []string{sg.AgentName, agentName, sg.IdentName} {
		if name = strings.TrimSpace(name); name != "" && strings.EqualFold(name, strings.TrimSpace(c.AuthorName)) {
			return true
		}
	}
	return false
}

// EfficiencyCommits lists the commits whose own time is in [since, until). A commit is one however many hashes it has had: a rebase, an amend that keeps the message or a cherry-pick gives a new hash with the
// same subject and the same author time, and the copies are one commit (the first hash recorded names it). The same hash in two checkouts is one commit too. Each commit lists every session that saw it, in the order
// the snapshots were recorded: the caller decides which of them made it (it knows when the sessions began). A snapshot with no session, or with no commit time that parses, is left out.
func (s *SessionStore) EfficiencyCommits(ctx context.Context, since, until time.Time) ([]EfficiencyCommit, error) {
	// recorded_at moves forward on the newest snapshot of a session at every poll, so it is never before the commit: a snapshot recorded before the window cannot hold a commit of it.
	var rows []struct {
		ID        int64   `db:"id"`
		Hash      string  `db:"commit_hash"`
		Subject   string  `db:"commit_subject"`
		SessionID string  `db:"session_id"`
		AgentName string  `db:"agent_name"`
		AgentType string  `db:"agent_type"`
		Branch    string  `db:"branch"`
		At        *string `db:"commit_timestamp"`
		Author    string  `db:"author_name"`
		AuthorH   string  `db:"author_hash"`
		IdentName string  `db:"ident_name"`
		IdentHash string  `db:"ident_hash"`
	}
	if err := s.db.Reader().SelectContext(ctx, &rows, `SELECT id, commit_hash, COALESCE(commit_subject, '') AS commit_subject, session_id, agent_name, agent_type, branch, commit_timestamp,
		COALESCE(author_name, '') AS author_name, COALESCE(author_hash, '') AS author_hash, COALESCE(ident_name, '') AS ident_name, COALESCE(ident_hash, '') AS ident_hash FROM git_snapshots
		WHERE session_id IS NOT NULL AND session_id != '' AND commit_timestamp IS NOT NULL AND recorded_at >= ? ORDER BY id`, since.UTC().Format(ISOFormat)); err != nil {
		return nil, err
	}
	byKey := map[string]int{} // the commit's identity (hash, or subject and author time) to its place in out
	var out []EfficiencyCommit
	for _, r := range rows {
		if r.At == nil {
			continue
		}
		at, err := time.Parse(time.RFC3339, *r.At)
		if err != nil {
			continue
		}
		at = at.UTC()
		if at.Before(since) || !at.Before(until) {
			continue
		}
		sighting := CommitSighting{SessionID: r.SessionID, AgentName: r.AgentName, AgentType: r.AgentType, Branch: r.Branch, IdentName: r.IdentName, IdentHash: r.IdentHash}
		// the copies of a commit share its subject, author time and author; two commits that share the first two but not the author are two (#8999)
		copyKey := "s|" + at.Format(time.RFC3339) + "|" + r.AuthorH + "|" + r.Subject
		i, ok := byKey["h|"+r.Hash]
		if !ok && strings.TrimSpace(r.Subject) != "" {
			i, ok = byKey[copyKey]
		}
		if !ok {
			out = append(out, EfficiencyCommit{Hash: r.Hash, At: at})
			i = len(out) - 1
		}
		if out[i].AuthorName == "" && out[i].AuthorHash == "" {
			out[i].AuthorName, out[i].AuthorHash = r.Author, r.AuthorH
		}
		byKey["h|"+r.Hash] = i
		if strings.TrimSpace(r.Subject) != "" {
			byKey[copyKey] = i
		}
		dup := false
		for _, e := range out[i].Seen {
			if e.SessionID == r.SessionID {
				dup = true
				break
			}
		}
		if !dup {
			out[i].Seen = append(out[i].Seen, sighting)
		}
	}
	return out, nil
}

// SessionFacts is what is known of a session after it may have ended: when it began (the earliest of its live row, its transcript's first message and its first usage row) and its provider.
type SessionFacts struct {
	Start    time.Time // zero when unknown
	Provider string    // "" when unknown
}

// sessionFactsFresh is how long a session's complete facts are kept (#9359): a session's start and provider do not change once they are known, and the read of them is the slowest part of the Analytics
// efficiency reads after the tasks (every task's session, a query of its usage rows each: 115 ms for 5,000 sessions of 20 rows). Ten minutes bounds what a rewritten transcript index or a deleted
// session could still show; facts that are not complete (no start, or no provider) are never kept, so a session that has not recorded anything yet is asked for again.
const (
	sessionFactsFresh = 10 * time.Minute
	sessionFactsMax   = 20000
)

type sessionFactsCache struct {
	mu  sync.Mutex
	now func() time.Time
	m   map[string]cachedFacts
}

type cachedFacts struct {
	facts SessionFacts
	at    time.Time
}

// take returns the kept facts of the ids that have fresh ones, and the ids that have none.
func (c *sessionFactsCache) take(ids []string) (map[string]SessionFacts, []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	hit, miss := make(map[string]SessionFacts), make([]string, 0, len(ids))
	now := c.now()
	for _, id := range ids {
		if e, ok := c.m[id]; ok && now.Sub(e.at) < sessionFactsFresh {
			hit[id] = e.facts
		} else {
			miss = append(miss, id)
		}
	}
	return hit, miss
}

// keep remembers the complete facts among got.
func (c *sessionFactsCache) keep(got map[string]SessionFacts) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil || len(c.m) > sessionFactsMax {
		c.m = make(map[string]cachedFacts)
	}
	now := c.now()
	for id, f := range got {
		if !f.Start.IsZero() && f.Provider != "" {
			c.m[id] = cachedFacts{facts: f, at: now}
		}
	}
}

// SessionFacts reads the facts of the sessions ids, from the live row, the transcript index and the usage rows (raw and rolled up alike), whichever have them. The complete facts of a session are kept for
// ten minutes (sessionFactsFresh).
func (s *SessionStore) SessionFacts(ctx context.Context, ids []string) (map[string]SessionFacts, error) {
	hit, ids := s.facts.take(ids)
	out, err := s.readSessionFacts(ctx, ids)
	if err != nil {
		return nil, err
	}
	s.facts.keep(out)
	for id, f := range hit {
		out[id] = f
	}
	return out, nil
}

func (s *SessionStore) readSessionFacts(ctx context.Context, ids []string) (map[string]SessionFacts, error) {
	out := make(map[string]SessionFacts, len(ids))
	note := func(id, start, provider string) {
		f := out[id]
		if t, ok := parseSessionTime(start); ok && (f.Start.IsZero() || t.Before(f.Start)) {
			f.Start = t
		}
		if f.Provider == "" {
			f.Provider = provider
		}
		out[id] = f
	}
	const chunk = 400
	for from := 0; from < len(ids); from += chunk {
		part := ids[from:min(from+chunk, len(ids))]
		marks := strings.TrimSuffix(strings.Repeat("?,", len(part)), ",")
		args := make([]any, len(part))
		for i, id := range part {
			args[i] = id
		}
		var rows []struct {
			ID       string `db:"id"`
			Start    string `db:"start"`
			Provider string `db:"provider"`
		}
		for _, q := range []string{
			`SELECT session_id AS id, created_at AS start, agent_type AS provider FROM live_sessions WHERE session_id IN (` + marks + `)`,
			`SELECT session_id AS id, COALESCE(MIN(NULLIF(session_start_at, '')), '') AS start, MIN(agent_type) AS provider FROM token_usage_all WHERE session_id IN (` + marks + `) GROUP BY session_id`,
			`SELECT session_id AS id, COALESCE(first_timestamp, '') AS start, COALESCE(source_type, '') AS provider FROM session_index WHERE session_id IN (` + marks + `)`,
		} {
			rows = rows[:0]
			if err := s.db.Reader().SelectContext(ctx, &rows, q, args...); err != nil {
				return nil, err
			}
			for _, r := range rows {
				note(r.ID, r.Start, r.Provider)
			}
		}
	}
	return out, nil
}

func parseSessionTime(v string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, ISOFormat, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// LatestBranches is each session's most recent branch (the one its newest snapshot names), as the By branch read attributes a session's tokens.
func (s *SessionStore) LatestBranches(ctx context.Context) (map[string]string, error) {
	var rows []struct {
		SessionID string `db:"session_id"`
		Branch    string `db:"branch"`
	}
	if err := s.db.Reader().SelectContext(ctx, &rows, `SELECT session_id, branch FROM git_snapshots WHERE session_id IS NOT NULL AND session_id != ''
		AND id IN (SELECT MAX(id) FROM git_snapshots WHERE session_id IS NOT NULL GROUP BY session_id)`); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.SessionID] = r.Branch
	}
	return out, nil
}
